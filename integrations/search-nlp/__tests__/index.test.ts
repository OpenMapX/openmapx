import type {
  IntegrationContext,
  NlpProvider,
  RouteHandler,
} from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __buildProviders,
  __filterOpenBreakers,
  __rateLimitKey,
  applyLocalOnly,
  setup,
} from "../index";

interface FakeReply {
  statusCode: number;
  payload: unknown;
  headers: Record<string, string>;
  status(code: number): { send(data: unknown): void };
  header(name: string, value: string): void;
  send(data: unknown): void;
  type(contentType: string): void;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code: number) {
      reply.statusCode = code;
      return {
        send(data: unknown) {
          reply.payload = data;
        },
      };
    },
    header(name: string, value: string) {
      reply.headers[name] = value;
    },
    send(data: unknown) {
      reply.payload = data;
    },
    type() {},
  };
  return reply;
}

interface FakeCacheStore {
  map: Map<string, { value: unknown; expires: number | null }>;
}

function makeCtx(config: Record<string, unknown>): {
  ctx: IntegrationContext;
  routes: Map<string, RouteHandler>;
  store: FakeCacheStore;
} {
  const routes = new Map<string, RouteHandler>();
  const store: FakeCacheStore = { map: new Map() };

  const cache = {
    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = store.map.get(key);
      if (!entry) return null;
      if (entry.expires !== null && entry.expires < Date.now()) {
        store.map.delete(key);
        return null;
      }
      return entry.value as T;
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      store.map.set(key, {
        value,
        expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
    },
    async del(key: string): Promise<void> {
      store.map.delete(key);
    },
    async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };

  const ctx = {
    id: "search-nlp",
    config,
    cache,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRequiredService: () => null,
    getIntegrationsByDomain: () => [],
    registerRoute: (method: string, path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    },
    registerHealthCheck: vi.fn(),
    registerDisclosure: vi.fn(),
  } as unknown as IntegrationContext;

  return { ctx, routes, store };
}

function getHandler(routes: Map<string, RouteHandler>): RouteHandler {
  const handler = routes.get("POST /parse");
  if (!handler) throw new Error("POST /parse not registered");
  return handler;
}

const baseBody = {
  query: "coffee with outdoor seating",
  mapCenter: [2.35, 48.86],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

describe("search-nlp setup / POST /parse", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses a query through the keyword provider", async () => {
    const { ctx, routes } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const reply = makeReply();
    await handler({ query: {}, params: {}, body: baseBody }, reply);

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as {
      provider: string;
      cached: boolean;
      intent: { filter: { selectors: { tags: { key: string; value?: string }[] }[] } };
      resolvedBbox: { south: number };
    };
    expect(payload.provider).toBe("keyword");
    expect(
      payload.intent.filter.selectors.some((s) =>
        s.tags.some((t) => t.key === "amenity" && t.value === "cafe"),
      ),
    ).toBe(true);
    expect(payload.cached).toBe(false);
    expect(payload.resolvedBbox.south).toBe(48.85);
  });

  it("returns 400 when required body fields are missing", async () => {
    const { ctx, routes } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const reply = makeReply();
    await handler({ query: {}, params: {}, body: { query: "coffee" } }, reply);
    expect(reply.statusCode).toBe(400);
  });

  it("rate-limits per IP once the hourly limit is exceeded", async () => {
    const { ctx, routes } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
      rateLimitPerIpPerHour: 2,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const call = async () => {
      const reply = makeReply();
      await handler({ query: { ip: "5.5.5.5" }, params: {}, body: baseBody }, reply);
      return reply;
    };

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const third = await call();
    expect(third.statusCode).toBe(429);
    expect(third.headers["Retry-After"]).toBe("3600");
  });

  it("allows exactly N requests then 429s the (N+1)th, incrementing a shared bucket", async () => {
    const limit = 5;
    const { ctx, routes, store } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
      rateLimitPerIpPerHour: limit,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const ip = "9.9.9.9";
    const call = async () => {
      const reply = makeReply();
      await handler({ query: { ip }, params: {}, body: baseBody }, reply);
      return reply;
    };

    // First N requests are allowed.
    for (let i = 0; i < limit; i++) {
      expect((await call()).statusCode).toBe(200);
    }
    // The (N+1)th is denied.
    expect((await call()).statusCode).toBe(429);

    // The counter is stored in a single hour-bucketed key shared across the
    // requests, and it stopped incrementing once the limit was reached.
    const bucketKey = __rateLimitKey(ip);
    expect(store.map.get(bucketKey)?.value).toBe(limit);
  });

  it("uses a fixed hourly bucket: same bucket shares the count, later bucket resets", () => {
    const ip = "7.7.7.7";
    const hourMs = 3600 * 1000;
    // Two instants within the same hour bucket map to the same key.
    const a = 100 * hourMs + 10_000;
    const b = 100 * hourMs + 50_000;
    expect(__rateLimitKey(ip, a)).toBe(__rateLimitKey(ip, b));
    expect(__rateLimitKey(ip, a)).toBe(`nlp:rl:${ip}:100`);

    // The next hour produces a distinct key, so the count starts fresh.
    const later = 101 * hourMs + 1;
    expect(__rateLimitKey(ip, later)).toBe(`nlp:rl:${ip}:101`);
    expect(__rateLimitKey(ip, later)).not.toBe(__rateLimitKey(ip, a));
  });

  it("guarantees a keyword floor when chain has none", () => {
    const { ctx } = makeCtx({ enabled: true });
    const providers = __buildProviders(ctx, []);
    expect(providers.some((p) => p.id === "keyword")).toBe(true);
  });
});

describe("circuit breaker filtering", () => {
  it("excludes a cloud provider whose breaker key is set", async () => {
    const { ctx, store } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
    });
    // The cache stub reads keys verbatim (the real cache would namespace them).
    store.map.set("nlp:breaker:claude", { value: 1, expires: null });

    const cloud: NlpProvider = {
      id: "claude",
      label: "Claude",
      cacheKey: "claude:model",
      isAi: true,
      requiresNetwork: true,
      cloudProcessors: [],
      parseQuery: vi.fn(),
    };
    const local: NlpProvider = {
      id: "keyword",
      label: "Keyword",
      cacheKey: "keyword:v1",
      isAi: false,
      requiresNetwork: false,
      cloudProcessors: [],
      parseQuery: vi.fn(),
    };

    const active = await __filterOpenBreakers([cloud, local], ctx);
    expect(active.some((p) => p.id === "claude")).toBe(false);
    expect(active.some((p) => p.id === "keyword")).toBe(true);
  });
});

describe("applyLocalOnly", () => {
  const cloudProvider: NlpProvider = {
    id: "claude",
    label: "Claude",
    cacheKey: "claude:model",
    isAi: true,
    requiresNetwork: true,
    cloudProcessors: [],
    parseQuery: vi.fn(),
  };
  const localProvider: NlpProvider = {
    id: "local",
    label: "Local",
    cacheKey: "local:model",
    isAi: true,
    requiresNetwork: false,
    cloudProcessors: [],
    parseQuery: vi.fn(),
  };
  const keywordProv: NlpProvider = {
    id: "keyword",
    label: "Keyword",
    cacheKey: "keyword:v1",
    isAi: false,
    requiresNetwork: false,
    cloudProcessors: [],
    parseQuery: vi.fn(),
  };

  it("removes cloud (requiresNetwork) providers and preserves local ones", () => {
    const result = applyLocalOnly([cloudProvider, localProvider, keywordProv]);
    expect(result.some((p) => p.id === "claude")).toBe(false);
    expect(result.some((p) => p.id === "local")).toBe(true);
    expect(result.some((p) => p.id === "keyword")).toBe(true);
  });

  it("guarantees the keyword floor even when keyword is not in input", () => {
    const result = applyLocalOnly([cloudProvider]);
    expect(result.some((p) => p.id === "claude")).toBe(false);
    expect(result.some((p) => p.id === "keyword")).toBe(true);
  });

  it("is a no-op when there are no cloud providers", () => {
    const result = applyLocalOnly([localProvider, keywordProv]);
    expect(result).toHaveLength(2);
    expect(result.some((p) => p.id === "local")).toBe(true);
    expect(result.some((p) => p.id === "keyword")).toBe(true);
  });

  it("denies cloud by default in consent mode", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("cloud request attempted"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, routes } = makeCtx({
      providers: [{ id: "claude", type: "anthropic", model: "claude-haiku-4-5" }],
      anthropicApiKey: "sk-test-key",
      enabled: true,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const reply = makeReply();
    await handler({ query: {}, params: {}, body: baseBody }, reply);

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { provider: string };
    expect(payload.provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows cloud only after an explicit positive consent signal", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("expected cloud attempt"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, routes } = makeCtx({
      providers: [{ id: "claude", type: "anthropic", model: "claude-haiku-4-5" }],
      anthropicApiKey: "sk-test-key",
      enabled: true,
    });
    setup(ctx);

    const reply = makeReply();
    await getHandler(routes)(
      { query: {}, params: {}, body: { ...baseBody, cloudAccess: "consented" } },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect((reply.payload as { provider: string }).provider).toBe("keyword");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("honors defer-to-server only when the operator selected open mode", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("expected cloud attempt"));
    vi.stubGlobal("fetch", fetchMock);

    const consentDeployment = makeCtx({
      providers: [{ id: "claude", type: "anthropic", model: "claude-haiku-4-5" }],
      anthropicApiKey: "sk-test-key",
      privacyMode: "consent",
    });
    setup(consentDeployment.ctx);
    await getHandler(consentDeployment.routes)(
      { query: {}, params: {}, body: { ...baseBody, cloudAccess: "defer-to-server" } },
      makeReply(),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const openDeployment = makeCtx({
      providers: [{ id: "claude", type: "anthropic", model: "claude-haiku-4-5" }],
      anthropicApiKey: "sk-test-key",
      privacyMode: "open",
    });
    setup(openDeployment.ctx);
    await getHandler(openDeployment.routes)(
      { query: {}, params: {}, body: { ...baseBody, cloudAccess: "defer-to-server" } },
      makeReply(),
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("privacyMode strict", () => {
  it("excludes cloud providers server-side even with an explicit consent signal", async () => {
    // A chain with a cloud provider (claude, with an API key so it is built)
    // plus the keyword floor. In strict mode the cloud provider must never run.
    const { ctx, routes } = makeCtx({
      providers: [
        { id: "claude", type: "anthropic", model: "claude-haiku-4-5" },
        { id: "keyword", type: "keyword" },
      ],
      anthropicApiKey: "sk-test-key",
      privacyMode: "strict",
      enabled: true,
    });

    // Sanity: the cloud provider is actually present in the built chain, so the
    // keyword result below proves strict mode stripped it (not that it was never
    // built). A missing API key would silently drop claude and void the test.
    expect(__buildProviders(ctx).some((p) => p.id === "claude")).toBe(true);

    setup(ctx);
    const handler = getHandler(routes);

    const reply = makeReply();
    // Strict mode overrides the client's positive signal. The bogus key would
    // otherwise cause a network attempt before the keyword fallback.
    const fetchMock = vi.fn().mockRejectedValue(new Error("must not be called"));
    vi.stubGlobal("fetch", fetchMock);
    await handler(
      { query: {}, params: {}, body: { ...baseBody, cloudAccess: "consented" } },
      reply,
    );

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { provider: string };
    expect(payload.provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
