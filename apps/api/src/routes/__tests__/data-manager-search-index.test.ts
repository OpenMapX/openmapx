import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockTryAdminSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ user: { id: "admin-1" } }),
);
vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../../utils/require-admin.js", () => ({
  tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
}));
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));

const fetchMock = vi.hoisted(() => vi.fn());
let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "service-token";
  process.env.DATA_MANAGER_URL = "https://data-manager.test:4000";
  vi.stubGlobal("fetch", fetchMock);
  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  fetchMock.mockReset();
  mockTryAdminSession.mockReset();
  mockTryAdminSession.mockResolvedValue({ user: { id: "admin-1" } });
});

describe("GET /data-manager/search-index/status", () => {
  it("requires an admin session and rejects a service token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/data-manager/search-index/status",
      headers: { authorization: "Bearer service-token" },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies status with data-manager authentication", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ region: "europe/germany", status: "ready", stale: false }),
    );
    const res = await app.inject({ method: "GET", url: "/data-manager/search-index/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ region: "europe/germany", status: "ready" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://data-manager.test:4000/search-index/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer service-token" }),
      }),
    );
  });

  it("preserves the data-manager 404 response for an absent index", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: false, error: "osm_search index not built" }, { status: 404 }),
    );
    const res = await app.inject({ method: "GET", url: "/data-manager/search-index/status" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: "osm_search index not built" });
  });
});
