import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuth, resolveAuthToken } from "../src/auth.js";

const TOKEN = "test-secret-token";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerAuth(app, TOKEN);
  // A protected route plus the health routes the hook must let through.
  app.get("/protected", async () => ({ ok: true }));
  app.get("/live", async () => ({ ok: true }));
  app.get("/status", async () => ({ ok: true }));
  app.get("/internal/metrics", async () => ({ ok: true }));
  app.get("/internal/transit/operator-feed/:handle", async () => ({ ok: true }));
  await app.ready();
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerAuth", () => {
  it("rejects a protected request with no token (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a wrong token (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts the correct Bearer token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts the correct x-data-manager-token header", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-data-manager-token": TOKEN },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets /status through without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets /live through without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/live" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets /internal/metrics through without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/metrics" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets only a well-formed one-use relay GET capability through without the bearer token", async () => {
    const app = await buildApp();
    const handle = "a".repeat(64);
    const allowed = await app.inject({
      method: "GET",
      url: `/internal/transit/operator-feed/${handle}`,
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/internal/transit/operator-feed/not-a-capability",
    });
    const wrongMethod = await app.inject({
      method: "POST",
      url: `/internal/transit/operator-feed/${handle}`,
    });

    expect(allowed.statusCode).toBe(200);
    expect(malformed.statusCode).toBe(401);
    expect(wrongMethod.statusCode).toBe(401);
    await app.close();
  });

  it("lets /status through even with a query string", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/status?probe=1" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("resolveAuthToken", () => {
  const stubApp = () => ({ log: { error: vi.fn(), warn: vi.fn() } }) as unknown as FastifyInstance;

  it("returns the configured token (trimmed)", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "  configured-token  ");
    expect(resolveAuthToken(stubApp())).toBe("configured-token");
  });

  it("throws in production when unset", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveAuthToken(stubApp())).toThrow(/required in production/i);
  });

  it("generates a 64-hex ephemeral token in non-production when unset", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "development");
    const token = resolveAuthToken(stubApp());
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});
