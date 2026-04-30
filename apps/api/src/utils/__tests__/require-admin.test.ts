import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the better-auth getSession import so the test doesn't need a live auth
// stack. Returns null by default; individual tests override per-call as needed.
const mockGetSession = vi.fn();
vi.mock("../../auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// Loaded *after* the mock is registered.
const { requireAdmin } = await import("../require-admin");

beforeEach(() => {
  mockGetSession.mockReset();
  delete process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH;
  delete process.env.OPENMAPX_LOCAL_ADMIN_TOKEN;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  delete process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH;
  delete process.env.OPENMAPX_LOCAL_ADMIN_TOKEN;
  delete process.env.NODE_ENV;
});

function makeApp() {
  const app = Fastify();
  app.get("/protected", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    return { ok: true, userId: session.user.id };
  });
  return app;
}

describe("requireAdmin loopback short-circuit", () => {
  it("admits a loopback request that carries the custom local-admin header", async () => {
    const app = makeApp();
    // app.inject() defaults remoteAddress to 127.0.0.1, which Fastify reports as `request.ip`.
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-openmapx-local-admin": "" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, userId: "loopback" });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("rejects a loopback request lacking the custom header (CSRF guard) in dev", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    // No header → simulate a same-origin <form action> CSRF attempt; browsers
    // cannot set the custom header without a CORS preflight.
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("respects OPENMAPX_DISABLE_LOCALHOST_AUTH=1 (no short-circuit)", async () => {
    process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH = "1";
    mockGetSession.mockResolvedValue(null); // no cookies, no session
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("rejects 403 for an authed non-admin user when loopback short-circuit is disabled", async () => {
    process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH = "1";
    mockGetSession.mockResolvedValue({
      user: { id: "u1", role: "user" },
      session: { id: "s1" },
    });
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it("admits an authed admin user when loopback short-circuit is disabled", async () => {
    process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH = "1";
    mockGetSession.mockResolvedValue({
      user: { id: "admin1", role: "admin" },
      session: { id: "s1" },
    });
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, userId: "admin1" });
  });

  it("requires the local admin token when OPENMAPX_LOCAL_ADMIN_TOKEN is set", async () => {
    process.env.OPENMAPX_LOCAL_ADMIN_TOKEN = "s3cret";
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    // No token header → loopback short-circuit must NOT admit, and no better-auth session exists.
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("admits a loopback request that presents the correct local admin token", async () => {
    process.env.OPENMAPX_LOCAL_ADMIN_TOKEN = "s3cret";
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-openmapx-local-admin": "s3cret" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, userId: "loopback" });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("rejects a loopback request with a wrong token", async () => {
    process.env.OPENMAPX_LOCAL_ADMIN_TOKEN = "s3cret";
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-openmapx-local-admin": "WRONG" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("denies loopback bypass entirely in production when no token is configured", async () => {
    process.env.NODE_ENV = "production";
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
