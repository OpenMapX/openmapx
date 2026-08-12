import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  corsOptions,
  makeRateLimitTierHook,
  makeTimelineAwareRateLimit,
  type RateLimitTiers,
  trustProxyConfig,
  uniformErrorHandler,
} from "./server-wiring.js";
import { RateLimiter } from "./utils/rate-limit.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trustProxyConfig", () => {
  it("defaults to 1 when unset", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "");
    expect(trustProxyConfig()).toBe(1);
  });

  it("parses 0 for direct exposure", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "0");
    expect(trustProxyConfig()).toBe(0);
  });

  it("parses a positive hop count", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "3");
    expect(trustProxyConfig()).toBe(3);
  });

  it("throws on a non-integer value", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "yes");
    expect(() => trustProxyConfig()).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("throws on a negative value", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "-1");
    expect(() => trustProxyConfig()).toThrow(/TRUST_PROXY_HOPS/);
  });
});

describe("uniformErrorHandler", () => {
  async function appThatThrows(error: Error): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.setErrorHandler(uniformErrorHandler);
    app.get("/boom", async () => {
      throw error;
    });
    await app.ready();
    return app;
  }

  it("preserves a 4xx status and message", async () => {
    const app = await appThatThrows(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Authentication required" });
    await app.close();
  });

  it("masks 5xx internals and does not leak the message", async () => {
    const app = await appThatThrows(new Error("db password xyz leaked"));
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal Server Error" });
    expect(res.payload).not.toContain("leaked");
    await app.close();
  });
});

describe("corsOptions", () => {
  async function corsApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cors, corsOptions());
    app.get("/api/thing", async (_request, reply) => {
      return reply
        .header("ETag", `sha256-${"a".repeat(64)}`)
        .header("Content-Range", "bytes 4-7/8")
        .send({ ok: true });
    });
    await app.ready();
    return app;
  }

  it("reflects an allowed origin and enables credentials", async () => {
    vi.stubEnv("CORS_ORIGIN", "http://allowed.test, http://second.test");
    const app = await corsApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/thing",
      headers: { origin: "http://allowed.test" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://allowed.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-expose-headers"]).toContain("ETag");
    expect(res.headers["access-control-expose-headers"]).toContain("Content-Range");
    expect(res.headers["access-control-expose-headers"]).toContain("X-OpenMapX-Fetched-At");
    expect(res.headers["access-control-expose-headers"]).toContain("X-OpenMapX-Stale");
    await app.close();
  });

  it("does not echo a disallowed origin", async () => {
    vi.stubEnv("CORS_ORIGIN", "http://allowed.test, http://second.test");
    const app = await corsApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/thing",
      headers: { origin: "http://evil.test" },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.test");
    await app.close();
  });
});

describe("makeRateLimitTierHook", () => {
  function stubTiers(): {
    hook: RateLimitTiers;
    stubs: Record<keyof RateLimitTiers, ReturnType<typeof vi.fn>>;
  } {
    const stubs = {
      auth: vi.fn(async () => {}),
      tile: vi.fn(async () => {}),
      expensive: vi.fn(async () => {}),
      public: vi.fn(async () => {}),
    };
    return { hook: stubs as unknown as RateLimitTiers, stubs };
  }

  async function tierApp(tiers: RateLimitTiers): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeRateLimitTierHook(tiers));
    app.all("/*", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  const cases: Array<{
    method?: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    tier: keyof RateLimitTiers | null;
  }> = [
    { url: "/health", tier: null },
    { url: "/api/auth/sign-in", tier: "auth" },
    { url: "/api/tiles/1/2/3", tier: "tile" },
    { url: "/api/offline/packages/glyphs/glyphs-v1/Noto%20Sans/0-255.pbf", tier: "tile" },
    { url: `/api/offline/packages/omp2-${"a".repeat(64)}/archive`, tier: "tile" },
    { url: "/api/offline/packages/prepare", tier: "expensive" },
    { url: "/api/isochrone?x=1", tier: "expensive" },
    { url: "/api/motis/plan", tier: "expensive" },
    { url: "/api/integrations/food-delivery/resolve", tier: "expensive" },
    { url: "/api/integrations/food-delivery/ubereats/open", tier: "expensive" },
    { url: "/api/integrations/restaurants/menu?website=https://example.com", tier: "expensive" },
    { url: "/api/integrations/food-delivery/providers?country=de", tier: "public" },
    { method: "GET", url: "/api/timeline/connection", tier: "public" },
    { method: "GET", url: "/api/timeline/day/2026-08-09", tier: null },
    { method: "PUT", url: "/api/timeline/connection", tier: "expensive" },
    { method: "POST", url: "/api/timeline/connection/test", tier: "expensive" },
    { method: "DELETE", url: "/api/timeline/connection", tier: "expensive" },
    { url: "/api/saved", tier: "public" },
    { url: "/whatever", tier: null },
  ];

  for (const { method = "GET", url, tier } of cases) {
    it(`routes ${method} ${url} to the ${tier ?? "no"} tier`, async () => {
      const { hook, stubs } = stubTiers();
      const app = await tierApp(hook);
      await app.inject({ method, url, remoteAddress: "198.51.100.7" });
      for (const key of Object.keys(stubs) as Array<keyof RateLimitTiers>) {
        if (key === tier) {
          expect(stubs[key]).toHaveBeenCalledTimes(1);
        } else {
          expect(stubs[key]).not.toHaveBeenCalled();
        }
      }
      await app.close();
    });
  }

  it("skips all tiers for a loopback socket peer", async () => {
    const { hook, stubs } = stubTiers();
    const app = await tierApp(hook);
    await app.inject({ method: "GET", url: "/api/saved", remoteAddress: "127.0.0.1" });
    for (const key of Object.keys(stubs) as Array<keyof RateLimitTiers>) {
      expect(stubs[key]).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it("passes a real limiter's 429 through to the response", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const { hook } = stubTiers();
    hook.public = limiter.preHandler();
    const app = await tierApp(hook);
    const first = await app.inject({
      method: "GET",
      url: "/api/saved",
      remoteAddress: "198.51.100.7",
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "GET",
      url: "/api/saved",
      remoteAddress: "198.51.100.7",
    });
    expect(second.statusCode).toBe(429);
    expect(second.payload).toContain("Too many requests");
    expect(second.headers["retry-after"]).toBeDefined();
    await app.close();
    limiter.destroy();
  });

  it("protects a registered timeline route before an exhausted parent limiter replies", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 2 * 86_400_000 });
    const { hook } = stubTiers();
    hook.expensive = makeTimelineAwareRateLimit(limiter);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeRateLimitTierHook(hook));
    await app.register(
      async (timeline) => {
        timeline.put("/timeline/connection", async () => ({ ok: true }));
      },
      { prefix: "/api" },
    );
    await app.ready();

    const first = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      remoteAddress: "198.51.100.7",
    });
    const exhausted = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      remoteAddress: "198.51.100.7",
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toEqual({
      error: "Timeline source is rate limited",
      code: "TIMELINE_RATE_LIMITED",
      retryAfterSeconds: 86_400,
    });
    expect(exhausted.headers["retry-after"]).toBe("86400");
    expect(exhausted.headers["cache-control"]).toBe("private, no-store");
    expect(exhausted.headers.pragma).toBe("no-cache");
    expect(exhausted.headers.vary).toContain("Cookie");
    await app.close();
    limiter.destroy();
  });

  it("skips the global IP limiter for timeline day reads while retaining privacy headers", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const { hook } = stubTiers();
    hook.expensive = makeTimelineAwareRateLimit(limiter);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeRateLimitTierHook(hook));
    await app.register(
      async (timeline) => {
        timeline.get("/timeline/day/:date", async () => ({ ok: true }));
      },
      { prefix: "/api" },
    );
    await app.ready();

    const request = {
      method: "GET" as const,
      url: "/api/timeline/day/2026-08-09",
      remoteAddress: "198.51.100.8",
    };
    const first = await app.inject(request);
    const exhausted = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ ok: true });
    expect(exhausted.headers["cache-control"]).toBe("private, no-store");
    expect(exhausted.headers.pragma).toBe("no-cache");
    expect(exhausted.headers.vary).toContain("Cookie");
    await app.close();
    limiter.destroy();
  });
});
