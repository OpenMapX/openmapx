import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const { meRoute } = await import("../me");

const fullSession = {
  user: {
    id: "u1",
    name: "Ada",
    email: "ada@example.com",
    emailVerified: true,
    image: "https://example.com/a.png",
    role: "admin",
    banned: false,
    banReason: null,
    normalizedEmail: "ada@example.com",
    twoFactorEnabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  session: {
    id: "s1",
    userId: "u1",
    token: "fixture-not-a-real-token",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ipAddress: "203.0.113.7",
    userAgent: "fixture-agent/1.0",
    impersonatedBy: null,
  },
};

beforeEach(() => {
  mockGetSession.mockReset();
});

async function injectMe() {
  const app = Fastify();
  await app.register(meRoute, { prefix: "/api" });
  const response = await app.inject({ method: "GET", url: "/api/me" });
  await app.close();
  return response;
}

describe("GET /api/me", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await injectMe();

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });

  it("returns the fields the admin layout needs without allowing caching", async () => {
    mockGetSession.mockResolvedValue(fullSession as never);

    const res = await injectMe();
    const body = JSON.parse(res.body);

    expect(body.user).toEqual({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: "https://example.com/a.png",
      role: "admin",
    });
    expect(body.session).toEqual({ expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("does not return the session token", async () => {
    mockGetSession.mockResolvedValue(fullSession as never);

    const res = await injectMe();
    const body = JSON.parse(res.body);

    expect(body.session).not.toHaveProperty("token");
    expect(res.body).not.toContain("fixture-not-a-real-token");
  });

  it("does not return stored client or impersonation metadata", async () => {
    mockGetSession.mockResolvedValue(fullSession as never);

    const res = await injectMe();
    const body = JSON.parse(res.body);

    expect(body.session).not.toHaveProperty("ipAddress");
    expect(body.session).not.toHaveProperty("userAgent");
    expect(body.session).not.toHaveProperty("impersonatedBy");
    expect(res.body).not.toContain("203.0.113.7");
  });

  it("does not leak unknown upstream fields", async () => {
    mockGetSession.mockResolvedValue({
      user: { ...fullSession.user, futureUserSecret: "leak-me-too" },
      session: { ...fullSession.session, futureSecret: "leak-me" },
    } as never);

    const res = await injectMe();

    expect(res.body).not.toContain("leak-me");
  });
});
