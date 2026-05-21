import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../rate-limit";

afterEach(() => {
  // Vitest's afterEach runs before the next test starts; nothing to clear here
  // because each test instantiates its own RateLimiter.
});

function buildApp(limiter: RateLimiter, opts: { trustProxy?: boolean | number } = {}) {
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  app.get("/ping", { preHandler: [limiter.preHandler()] }, async () => ({ ok: true }));
  return app;
}

describe("RateLimiter", () => {
  it("admits requests up to `max` then rejects with 429", async () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 });
    const app = buildApp(limiter);

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/ping" });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/ping" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();

    await app.close();
    limiter.destroy();
  });

  it("buckets requests per resolved IP", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const app = buildApp(limiter);

    // First client (default 127.0.0.1) — burns its single token.
    const a1 = await app.inject({ method: "GET", url: "/ping" });
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject({ method: "GET", url: "/ping" });
    expect(a2.statusCode).toBe(429);

    // Different remote address — gets its own bucket.
    const b1 = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.2",
    });
    expect(b1.statusCode).toBe(200);

    await app.close();
    limiter.destroy();
  });

  it("under trustProxy=1, the resolved client IP (not the proxy) is the bucket key", async () => {
    // The bucket key is `req.ip`, which under `trustProxy` is the leftmost
    // X-Forwarded-For entry. Two real clients behind the same proxy must
    // therefore get separate buckets — otherwise rate limits collapse to a
    // single bucket per upstream proxy in deployment.
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const app = buildApp(limiter, { trustProxy: 1 });

    const a = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.5", // the proxy
      headers: { "x-forwarded-for": "198.51.100.1" }, // real client A
    });
    const b = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "198.51.100.2" }, // real client B
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    // Same client A again → out of tokens.
    const aAgain = await app.inject({
      method: "GET",
      url: "/ping",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(aAgain.statusCode).toBe(429);

    await app.close();
    limiter.destroy();
  });
});
