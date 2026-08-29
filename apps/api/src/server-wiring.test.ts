import { Writable } from "node:stream";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlledRequestLoggingOptions,
  corsOptions,
  makeRateLimitTierHook,
  makeSecurityResponseHeaderHook,
  makeStatusAwareRateLimit,
  makeTimelineAwareRateLimit,
  type RateLimitTiers,
  registerControlledRequestLogging,
  trustProxyConfig,
  uniformErrorHandler,
} from "./server-wiring.js";
import { RateLimiter } from "./utils/rate-limit.js";
import { createSafePinoOptions } from "./utils/safe-log-fields.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trustProxyConfig", () => {
  it("trusts no forwarding headers when proxy ranges are unset", () => {
    vi.stubEnv("TRUST_PROXY_RANGES", "");
    expect(trustProxyConfig()).toBe(false);
  });

  it("parses explicit IP, CIDR, and private-network aliases", () => {
    vi.stubEnv("TRUST_PROXY_RANGES", " loopback, 172.16.0.0/12, fd4d:5058::/64, uniquelocal ");
    expect(trustProxyConfig()).toEqual([
      "loopback",
      "172.16.0.0/12",
      "fd4d:5058::/64",
      "uniquelocal",
    ]);
  });

  it.each([
    "yes",
    "127.0.0.1,",
    "127.0.0.1/33",
    "fd4d:5058::/129",
    "10.0.0.1/nope",
    "10.0.0.1/1e1",
    "10.0.0.1/+8",
    "10.0.0.1/8.5",
  ])("rejects invalid proxy range %s", (value) => {
    vi.stubEnv("TRUST_PROXY_RANGES", value);
    expect(() => trustProxyConfig()).toThrow(/TRUST_PROXY_RANGES/);
  });

  it.each(["0.0.0.0/0", "::/0"])("rejects trust-all proxy range %s", (value) => {
    vi.stubEnv("TRUST_PROXY_RANGES", value);
    expect(() => trustProxyConfig()).toThrow(/trust every address/i);
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
    expect(res.headers.vary).toMatch(/(?:^|,\s*)Origin(?:,|$)/i);
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
    expect(res.headers.vary).toMatch(/(?:^|,\s*)Origin(?:,|$)/i);
    await app.close();
  });

  it("uses normalized exact origins from the shared web-origin policy", async () => {
    vi.stubEnv("CORS_ORIGIN", "HTTPS://ALLOWED.TEST:443");
    const app = await corsApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/thing",
      headers: { origin: "https://allowed.test" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.test");
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
      status: vi.fn(async () => {}),
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
    {
      method: "POST",
      url: "/api/integrations/transit/reachability/surface",
      tier: "expensive",
    },
    {
      method: "POST",
      url: "/api/integrations/transit/reachability/check",
      tier: "expensive",
    },
    { url: "/api/integrations/food-delivery/resolve", tier: "expensive" },
    { url: "/api/integrations/food-delivery/ubereats/open", tier: "expensive" },
    { url: "/api/integrations/restaurants/menu?website=https://example.com", tier: "expensive" },
    { url: "/api/integrations/food-delivery/providers?country=de", tier: "public" },
    { method: "GET", url: "/api/status", tier: "status" },
    { method: "GET", url: "/api/status?probe=public", tier: "status" },
    { method: "POST", url: "/api/status", tier: "public" },
    { method: "GET", url: "/api/status/", tier: "public" },
    { method: "GET", url: "/api/admin/status", tier: "public" },
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

  it.each(["/api/mobile-auth/issue", "/api/mobile-auth/exchange"])(
    "marks a global limiter 429 for %s private before its handler",
    async (url) => {
      const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
      const { hook } = stubTiers();
      hook.public = limiter.preHandler();
      const handler = vi.fn(async () => ({ ok: true }));
      const app = Fastify({ logger: false });
      app.addHook("onRequest", makeSecurityResponseHeaderHook());
      app.addHook("onRequest", makeRateLimitTierHook(hook));
      app.post(url, handler);
      await app.ready();

      const request = { method: "POST" as const, url, remoteAddress: "198.51.100.9" };
      const first = await app.inject(request);
      const exhausted = await app.inject(request);

      expect(first.statusCode).toBe(200);
      expect(exhausted.statusCode).toBe(429);
      for (const response of [first, exhausted]) {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
      }
      expect(handler).toHaveBeenCalledTimes(1);
      await app.close();
      limiter.destroy();
    },
  );

  it("keeps an exact public-status limiter 429 out of shared caches", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const { hook } = stubTiers();
    hook.status = makeStatusAwareRateLimit(limiter);
    const handler = vi.fn(async () => ({ ok: true }));
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeSecurityResponseHeaderHook());
    app.addHook("onRequest", makeRateLimitTierHook(hook));
    app.get("/api/status", handler);
    await app.ready();

    const request = {
      method: "GET" as const,
      url: "/api/status",
      remoteAddress: "198.51.100.10",
    };
    const first = await app.inject(request);
    const exhausted = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=15, stale-while-revalidate=45");
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.headers["cache-control"]).toBe("private, no-store");
    expect(exhausted.headers.pragma).toBe("no-cache");
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
    limiter.destroy();
  });

  it("marks an admin-status parent-limiter 429 private before route hooks", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const { hook } = stubTiers();
    hook.public = limiter.preHandler();
    const handler = vi.fn(async () => ({ ok: true }));
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeSecurityResponseHeaderHook());
    app.addHook("onRequest", makeRateLimitTierHook(hook));
    app.get("/api/admin/status", handler);
    await app.ready();

    const request = {
      method: "GET" as const,
      url: "/api/admin/status",
      remoteAddress: "198.51.100.11",
    };
    const first = await app.inject(request);
    const exhausted = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(exhausted.statusCode).toBe(429);
    for (const response of [first, exhausted]) {
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.vary).toContain("Cookie");
    }
    expect(handler).toHaveBeenCalledTimes(1);
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

describe("controlled request lifecycle logging", () => {
  function captureLogger() {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    return {
      chunks,
      logger: pino(createSafePinoOptions("info"), stream),
      records: () =>
        chunks
          .join("")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  it("emits only controlled start and completion fields with a matched route template", async () => {
    const capture = captureLogger();
    let now = 100;
    const app = Fastify(controlledRequestLoggingOptions(capture.logger));
    registerControlledRequestLogging(app, { now: () => now });
    app.post<{ Params: { id: string } }>("/items/:id", async (request) => {
      now = 112.5;
      return { id: request.params.id };
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/items/private-customer-id?token=fixture-query-token",
      headers: {
        cookie: "session=fixture-cookie",
        authorization: "Bearer fixture-authorization",
        "proxy-authorization": "Basic fixture-proxy-authorization",
        "x-forwarded-client-cert": "fixture-forwarded-certificate",
        "x-arbitrary-header": "fixture-arbitrary-header",
        "content-type": "application/json",
      },
      payload: { password: "fixture-body-password" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const records = capture.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: "request.start", method: "POST" });
    expect(records[0]).not.toHaveProperty("route");
    expect(records[1]).toMatchObject({
      event: "request.complete",
      method: "POST",
      route: "/items/:id",
      statusCode: 200,
      durationMs: 12.5,
    });
    expect(records[0].requestId).toBe(records[1].requestId);
    const output = capture.chunks.join("");
    for (const marker of [
      "private-customer-id",
      "fixture-query-token",
      "fixture-cookie",
      "fixture-authorization",
      "fixture-proxy-authorization",
      "fixture-forwarded-certificate",
      "fixture-arbitrary-header",
      "fixture-body-password",
    ]) {
      expect(output).not.toContain(marker);
    }
  });

  it("emits a safe error class and completion without error text or raw request data", async () => {
    const capture = captureLogger();
    let now = 200;
    const app = Fastify(controlledRequestLoggingOptions(capture.logger));
    registerControlledRequestLogging(app, { now: () => now });
    app.setErrorHandler(uniformErrorHandler);
    app.get("/explode/:id", async () => {
      now = 205;
      throw new Error(
        "upstream https://fixture-user:fixture-pass@errors.example.test/private?token=fixture-error-token Bearer fixture-bearer-token",
      );
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/explode/private-customer-id?session=fixture-query-session",
      headers: { cookie: "session=fixture-cookie" },
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    const records = capture.records();
    expect(records.map((record) => record.event)).toEqual([
      "request.start",
      "request.error",
      "request.complete",
    ]);
    expect(records.find((record) => record.event === "request.error")).toMatchObject({
      method: "GET",
      route: "/explode/:id",
      statusCode: 500,
      durationMs: 5,
      errorClass: "Error",
    });
    expect(records.find((record) => record.event === "request.complete")).toMatchObject({
      route: "/explode/:id",
      statusCode: 500,
      durationMs: 5,
    });
    const output = capture.chunks.join("");
    for (const marker of [
      "fixture-user",
      "fixture-pass",
      "private?",
      "fixture-error-token",
      "fixture-bearer-token",
      "private-customer-id",
      "fixture-query-session",
      "fixture-cookie",
    ]) {
      expect(output).not.toContain(marker);
    }
  });

  it("uses an unmatched sentinel rather than a raw not-found URL", async () => {
    const capture = captureLogger();
    const app = Fastify(controlledRequestLoggingOptions(capture.logger));
    registerControlledRequestLogging(app, { now: () => 1 });
    await app.ready();

    await app.inject({ url: "/missing/private-value?token=fixture-query-token" });
    await app.close();

    expect(capture.records().find((record) => record.event === "request.complete")).toMatchObject({
      route: "unmatched",
      statusCode: 404,
    });
    expect(capture.chunks.join("")).not.toMatch(/private-value|fixture-query-token/);
  });
});
