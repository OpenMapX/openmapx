import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the better-auth getSession import so the test doesn't need a live auth
// stack. Returns null by default; individual tests override per-call as needed.
const mockGetSession = vi.fn();
vi.mock("../../auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// Loaded *after* the mock is registered.
const { requireAdmin, tryAdminSession } = await import("../require-admin");

beforeEach(() => {
  mockGetSession.mockReset();
});

function makeApp() {
  const app = Fastify({ trustProxy: "uniquelocal" });
  // requireAdmin throws a 401/403 on failure; Fastify's default error handler
  // turns that into the response, so the route body only runs when admitted.
  app.get("/protected", async (request) => {
    const session = await requireAdmin(request);
    return { ok: true, userId: session.user.id };
  });
  return app;
}

describe("requireAdmin admits only an administrator session", () => {
  it("refuses a loopback peer without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    // app.inject() defaults remoteAddress to 127.0.0.1.
    const res = await app.inject({ method: "GET", url: "/protected" });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a request whose forwarded headers claim loopback", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("admits an administrator session from any peer", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin1", role: "admin" },
      session: { id: "s1" },
    });
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/protected", remoteAddress: "10.0.0.5" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, userId: "admin1" });
  });
});

describe("requireAdmin throws (no manual reply)", () => {
  it("throws a 401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(requireAdmin({ headers: {}, socket: {} } as never)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("throws a 403 for an authed non-admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1", role: "user" }, session: { id: "s1" } });
    await expect(requireAdmin({ headers: {}, socket: {} } as never)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("admits another allowed role when the caller names it", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "m1", role: "moderator" }, session: {} });
    await expect(
      requireAdmin({ headers: {}, socket: {} } as never, ["admin", "moderator"]),
    ).resolves.toMatchObject({ user: { id: "m1" } });
  });
});

describe("tryAdminSession (non-throwing)", () => {
  it("returns null instead of throwing when unauthorized", async () => {
    mockGetSession.mockResolvedValue(null);
    expect(await tryAdminSession({ headers: {}, socket: {} } as never)).toBeNull();
  });

  it("returns the session for an admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin1", role: "admin" },
      session: { id: "s1" },
    });
    const s = await tryAdminSession({ headers: {}, socket: {} } as never);
    expect(s?.user.id).toBe("admin1");
  });
});
