import type {
  IntegrationContext,
  NlpProvider,
  QuotaDecision,
  QuotaWindow,
  RouteHandler,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __buildProviders,
  __filterOpenBreakers,
  __rateLimitKey,
  applyLocalOnly,
  MAX_QUERY_CHARACTERS,
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

function makeCtx(
  config: Record<string, unknown>,
  extra: Partial<IntegrationContext> = {},
): {
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
    ...extra,
  } as unknown as IntegrationContext;

  return { ctx, routes, store };
}

/**
 * An in-memory stand-in for the shared quota store: counts every window per
 * bucket against its own limit, as the real atomic script does.
 */
function fakeRuntime(options: { unavailable?: boolean } = {}) {
  const used = new Map<string, number>();
  const consumeQuota = vi.fn(
    async (input: {
      bucket: string;
      cost: number;
      windows: readonly QuotaWindow[];
    }): Promise<QuotaDecision> => {
      if (options.unavailable) {
        return { allowed: false, remaining: {}, retryAt: null, diagnostic: "store_unavailable" };
      }
      const keys = input.windows.map((window) => `${input.bucket}:${window.id}`);
      const denied = input.windows.some(
        (window, index) => (used.get(keys[index] as string) ?? 0) + input.cost > window.limit,
      );
      if (denied) return { allowed: false, remaining: {}, retryAt: Date.now() + 1_000 };
      for (const key of keys) used.set(key, (used.get(key) ?? 0) + input.cost);
      return { allowed: true, remaining: {}, retryAt: null };
    },
  );
  return { consumeQuota, upstreamRuntime: { consumeQuota } as unknown as UpstreamRuntime };
}

type ParseRequest = Parameters<RouteHandler>[0];

function parseRequest(body: unknown, overrides: Partial<ParseRequest> = {}): ParseRequest {
  return { query: {}, params: {}, body, headers: {}, clientKey: "client-a", ...overrides };
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
    await handler(parseRequest(baseBody), reply);

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
    await handler(parseRequest({ query: "coffee" }), reply);
    expect(reply.statusCode).toBe(400);
  });

  it("rate-limits by the host's client key and ignores any ip query parameter", async () => {
    const { ctx, routes } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
      rateLimitPerIpPerHour: 2,
    });
    setup(ctx);
    const handler = getHandler(routes);

    const call = async (ip: string) => {
      const reply = makeReply();
      await handler(parseRequest(baseBody, { query: { ip } }), reply);
      return reply;
    };

    expect((await call("5.5.5.5")).statusCode).toBe(200);
    expect((await call("6.6.6.6")).statusCode).toBe(200);
    const third = await call(`${Math.random()}`);
    expect(third.statusCode).toBe(429);
    expect(third.headers["Retry-After"]).toBe("3600");
  });

  it("keeps one client from exhausting another client's bucket", async () => {
    const { ctx, routes } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      enabled: true,
      rateLimitPerIpPerHour: 1,
    });
    setup(ctx);
    const handler = getHandler(routes);
    const call = async (clientKey: string) => {
      const reply = makeReply();
      await handler(parseRequest(baseBody, { clientKey }), reply);
      return reply.statusCode;
    };

    expect(await call("client-a")).toBe(200);
    expect(await call("client-a")).toBe(429);
    expect(await call("client-b")).toBe(200);
  });

  it("counts the parse quota atomically in the shared runtime when it is present", async () => {
    const runtime = fakeRuntime();
    const { ctx, routes } = makeCtx(
      { providers: [{ id: "keyword", type: "keyword" }], rateLimitPerIpPerHour: 1 },
      { upstreamRuntime: runtime.upstreamRuntime },
    );
    setup(ctx);
    const handler = getHandler(routes);
    const first = makeReply();
    const second = makeReply();

    await handler(parseRequest(baseBody), first);
    await handler(parseRequest(baseBody), second);

    expect([first.statusCode, second.statusCode]).toEqual([200, 429]);
    expect(runtime.consumeQuota).toHaveBeenCalledWith({
      bucket: "parse",
      cost: 1,
      windows: [{ id: "client:client-a", limit: 1, durationMs: 3_600_000 }],
    });
  });

  it("serves only the keyword floor when the shared quota store is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("must not be called"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, routes } = makeCtx(
      {
        providers: [
          { id: "local", type: "ollama", model: "gemma3:4b-it-qat" },
          { id: "claude", type: "anthropic", model: "claude-haiku-4-5" },
        ],
        anthropicApiKey: "sk-test-key",
        privacyMode: "open",
      },
      { upstreamRuntime: fakeRuntime({ unavailable: true }).upstreamRuntime },
    );
    setup(ctx);
    fetchMock.mockClear();
    const reply = makeReply();

    await getHandler(routes)(
      parseRequest({ ...baseBody, cloudAccess: "consented" }, { userId: "user-1" }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect((reply.payload as { provider: string }).provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it(`rejects a query longer than ${MAX_QUERY_CHARACTERS} characters`, async () => {
    const { ctx, routes } = makeCtx({ providers: [{ id: "keyword", type: "keyword" }] });
    setup(ctx);
    const handler = getHandler(routes);
    const call = async (query: string) => {
      const reply = makeReply();
      await handler(parseRequest({ ...baseBody, query }), reply);
      return reply;
    };

    const tooLong = await call("a".repeat(MAX_QUERY_CHARACTERS + 1));
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.payload).toEqual({ error: "query_too_long" });
    expect((await call(`cafe ${"a".repeat(MAX_QUERY_CHARACTERS - 5)}`)).statusCode).toBe(200);
    // Characters, not UTF-16 units: 500 emoji are 1,000 units but still allowed.
    expect((await call("☕".repeat(MAX_QUERY_CHARACTERS))).statusCode).toBe(200);
  });

  it("keys the cache fallback counter by client key in a fixed hour bucket", async () => {
    const limit = 3;
    const { ctx, routes, store } = makeCtx({
      providers: [{ id: "keyword", type: "keyword" }],
      rateLimitPerIpPerHour: limit,
    });
    setup(ctx);
    const handler = getHandler(routes);
    for (let i = 0; i <= limit; i++) await handler(parseRequest(baseBody), makeReply());

    expect(store.map.get(__rateLimitKey("client-a"))?.value).toBe(limit);
  });

  it("uses a fixed hourly bucket: same bucket shares the count, later bucket resets", () => {
    const key = "client-a";
    const hourMs = 3600 * 1000;
    const a = 100 * hourMs + 10_000;
    const b = 100 * hourMs + 50_000;
    expect(__rateLimitKey(key, a)).toBe(__rateLimitKey(key, b));
    expect(__rateLimitKey(key, a)).toBe(`nlp:rl:${key}:100`);
    const later = 101 * hourMs + 1;
    expect(__rateLimitKey(key, later)).toBe(`nlp:rl:${key}:101`);
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
});

describe("server-side cloud decision", () => {
  const cloudConfig = {
    providers: [{ id: "claude", type: "anthropic", model: "claude-haiku-4-5" }],
    anthropicApiKey: "sk-test-key",
  };

  function cloudAttempts() {
    const fetchMock = vi.fn().mockRejectedValue(new Error("cloud request attempted"));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("denies cloud by default in consent mode", async () => {
    const fetchMock = cloudAttempts();
    const { ctx, routes } = makeCtx(cloudConfig, {
      upstreamRuntime: fakeRuntime().upstreamRuntime,
    });
    setup(ctx);

    const reply = makeReply();
    await getHandler(routes)(parseRequest(baseBody, { userId: "user-1" }), reply);

    expect((reply.payload as { provider: string }).provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let an anonymous caller assert its own consent", async () => {
    const fetchMock = cloudAttempts();
    const { ctx, routes } = makeCtx(cloudConfig, {
      upstreamRuntime: fakeRuntime().upstreamRuntime,
    });
    setup(ctx);

    const reply = makeReply();
    await getHandler(routes)(parseRequest({ ...baseBody, cloudAccess: "consented" }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({ provider: "keyword", cloudAvailable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses cloud for a signed-in user who opted in", async () => {
    const fetchMock = cloudAttempts();
    const runtime = fakeRuntime();
    const { ctx, routes } = makeCtx(cloudConfig, { upstreamRuntime: runtime.upstreamRuntime });
    setup(ctx);

    const reply = makeReply();
    await getHandler(routes)(
      parseRequest({ ...baseBody, cloudAccess: "consented" }, { userId: "user-1" }),
      reply,
    );

    expect(reply.payload).toMatchObject({ cloudAvailable: true });
    expect(fetchMock).toHaveBeenCalled();
    const cloudCall = runtime.consumeQuota.mock.calls.find(([input]) => input.bucket === "cloud");
    expect(cloudCall?.[0].windows).toEqual([
      { id: expect.stringMatching(/^client:user:[0-9a-f]{32}$/), limit: 20, durationMs: 3_600_000 },
      { id: "deployment", limit: 1_000, durationMs: 86_400_000 },
    ]);
    expect(JSON.stringify(cloudCall)).not.toContain("user-1");
  });

  it("honors defer-to-server only when the operator selected open mode", async () => {
    const fetchMock = cloudAttempts();
    const consentDeployment = makeCtx(
      { ...cloudConfig, privacyMode: "consent" },
      { upstreamRuntime: fakeRuntime().upstreamRuntime },
    );
    setup(consentDeployment.ctx);
    await getHandler(consentDeployment.routes)(
      parseRequest({ ...baseBody, cloudAccess: "defer-to-server" }, { userId: "user-1" }),
      makeReply(),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const openDeployment = makeCtx(
      { ...cloudConfig, privacyMode: "open" },
      { upstreamRuntime: fakeRuntime().upstreamRuntime },
    );
    setup(openDeployment.ctx);
    await getHandler(openDeployment.routes)(
      parseRequest({ ...baseBody, cloudAccess: "defer-to-server" }),
      makeReply(),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("never calls a cloud provider without a shared budget store", async () => {
    const fetchMock = cloudAttempts();
    const { ctx, routes } = makeCtx({ ...cloudConfig, privacyMode: "open" });
    setup(ctx);

    const reply = makeReply();
    await getHandler(routes)(parseRequest({ ...baseBody, cloudAccess: "consented" }), reply);

    expect((reply.payload as { provider: string }).provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops calling the cloud provider once the deployment's daily budget is spent", async () => {
    const fetchMock = cloudAttempts();
    const { ctx, routes, store } = makeCtx(
      { ...cloudConfig, privacyMode: "open", cloudRequestsPerDay: 1 },
      { upstreamRuntime: fakeRuntime().upstreamRuntime },
    );
    setup(ctx);
    const handler = getHandler(routes);

    await handler(parseRequest({ ...baseBody, cloudAccess: "consented" }), makeReply());
    const afterFirst = fetchMock.mock.calls.length;
    // The rejected fetch above trips the provider breaker; clear it so only
    // the budget can keep the provider from running.
    store.map.delete("nlp:breaker:claude");
    const second = makeReply();
    await handler(
      parseRequest({ ...baseBody, cloudAccess: "consented" }, { clientKey: "client-b" }),
      second,
    );

    expect(afterFirst).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst);
    expect((second.payload as { provider: string }).provider).toBe("keyword");
    // A refused budget is not a provider failure, so it trips no breaker.
    expect(store.map.has("nlp:breaker:claude")).toBe(false);
  });

  it("caps one client at its hourly share of the cloud budget", async () => {
    const fetchMock = cloudAttempts();
    const { ctx, routes, store } = makeCtx(
      { ...cloudConfig, privacyMode: "open", cloudRequestsPerClientPerHour: 1 },
      { upstreamRuntime: fakeRuntime().upstreamRuntime },
    );
    setup(ctx);
    const handler = getHandler(routes);
    const consented = (clientKey: string) =>
      parseRequest({ ...baseBody, cloudAccess: "consented" }, { clientKey });

    await handler(consented("client-a"), makeReply());
    const afterFirst = fetchMock.mock.calls.length;
    store.map.delete("nlp:breaker:claude");
    await handler(consented("client-a"), makeReply());
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst);

    store.map.delete("nlp:breaker:claude");
    await handler(consented("client-b"), makeReply());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
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
      parseRequest({ ...baseBody, cloudAccess: "consented" }, { userId: "user-1" }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { provider: string };
    expect(payload.provider).toBe("keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
