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
});

afterEach(() => {
  delete process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH;
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
  it("admits a loopback request without consulting better-auth", async () => {
    const app = makeApp();
    // app.inject() defaults remoteAddress to 127.0.0.1, which Fastify reports as `request.ip`.
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, userId: "loopback" });
    expect(mockGetSession).not.toHaveBeenCalled();
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
});
