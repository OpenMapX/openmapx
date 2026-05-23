import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderHealthState } from "../../services/provider-health/index.js";

vi.mock("../../db/index.js", () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    offset: () => builder,
    groupBy: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(onFulfilled, onRejected),
  });
  return {
    db: { select: () => builder },
    sql: {},
  };
});

const requireAdminMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: requireAdminMock,
}));

const providerHealthMock = vi.hoisted(() => ({
  getAll: vi.fn(),
  getState: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../../services/provider-health/registry.js", () => ({
  getProviderHealth: () => providerHealthMock,
  setProviderHealth: vi.fn(),
  ProviderHealth: class {},
}));

beforeAll(() => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "service-token";
});

let app: FastifyInstance;

beforeAll(async () => {
  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

beforeEach(() => {
  requireAdminMock.mockReset();
  providerHealthMock.getAll.mockReset();
  providerHealthMock.getState.mockReset();
  providerHealthMock.reset.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleState: ProviderHealthState = {
  success: 12,
  failure: 3,
  emaLatencyMs: 80,
  window: [
    { outcome: "ok", at: "2026-05-21T00:00:00.000Z", latencyMs: 80 },
    { outcome: "error", at: "2026-05-21T00:00:30.000Z", latencyMs: 200 },
  ],
  lastFailureAt: "2026-05-21T00:00:30.000Z",
  lastFailureReason: "boom",
  windowFailureRate: 0.5,
};

describe("GET /data-manager/providers", () => {
  it("returns 401 when no auth is provided", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/data-manager/providers" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with sorted providers when admin session is present", async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: { id: "sess-1" },
    });
    providerHealthMock.getAll.mockResolvedValue({
      zeta: { ...sampleState },
      alpha: { ...sampleState, success: 5 },
    });
    const res = await app.inject({ method: "GET", url: "/data-manager/providers" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Array<{ id: string }> };
    expect(body.providers.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });

  it("accepts service-token authentication", async () => {
    requireAdminMock.mockResolvedValue(null);
    providerHealthMock.getAll.mockResolvedValue({});
    const res = await app.inject({
      method: "GET",
      url: "/data-manager/providers",
      headers: { authorization: "Bearer service-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [] });
  });
});

describe("GET /data-manager/providers/:id", () => {
  it("returns 200 + state when the provider exists", async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: { id: "sess-1" },
    });
    providerHealthMock.getState.mockResolvedValue(sampleState);

    const res = await app.inject({ method: "GET", url: "/data-manager/providers/acme" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; success: number };
    expect(body.id).toBe("acme");
    expect(body.success).toBe(12);
  });

  it("returns 404 when the provider is unknown", async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: { id: "sess-1" },
    });
    providerHealthMock.getState.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/data-manager/providers/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /data-manager/providers/:id/reset", () => {
  it("returns 200 + clears state when admin session is present", async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: { id: "sess-1" },
    });
    providerHealthMock.reset.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/providers/acme/reset",
    });
    expect(res.statusCode).toBe(200);
    expect(providerHealthMock.reset).toHaveBeenCalledWith("acme");
    expect(res.json()).toEqual({ ok: true, providerId: "acme" });
  });

  it("returns 403 when caller authenticates with only a bearer token", async () => {
    requireAdminMock.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/providers/acme/reset",
      headers: { authorization: "Bearer service-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(providerHealthMock.reset).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth is provided", async () => {
    requireAdminMock.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/providers/acme/reset",
    });
    expect(res.statusCode).toBe(401);
    expect(providerHealthMock.reset).not.toHaveBeenCalled();
  });
});
