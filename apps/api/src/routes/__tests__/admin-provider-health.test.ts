import { createApiClient } from "@openmapx/core";
import { listAdminProviderHealth } from "@openmapx/core/api-admin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderHealthObservation } from "../../services/provider-health/index.js";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const { requireAdmin: mockRequireAdmin, writeAuditLog } = installAdminRouteMocks();

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

function rejectAs(statusCode: number, message: string) {
  mockRequireAdmin.mockRejectedValueOnce(Object.assign(new Error(message), { statusCode }));
}

let app: FastifyInstance;

beforeAll(async () => {
  const { adminProviderHealthRoute } = await import("../admin-provider-health.js");
  app = await createAdminTestApp(adminProviderHealthRoute);
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const sampleState: ProviderHealthObservation = {
  schema: 2,
  state: "degraded",
  successCount: 12,
  failureCount: 3,
  countedFailureCount: 3,
  consecutiveSuccesses: 0,
  consecutiveFailures: 1,
  reopenCount: 0,
  emaLatencyMs: 80,
  window: [
    { outcome: "ok", at: "2026-05-21T00:00:00.000Z", latencyMs: 80 },
    { outcome: "error", at: "2026-05-21T00:00:30.000Z", latencyMs: 200 },
  ],
  lastFailureAt: "2026-05-21T00:00:30.000Z",
  lastSuccessAt: "2026-05-21T00:00:00.000Z",
  lastFailureOutcome: "connection",
  lastOperatorMessage: "boom",
  retryAt: null,
  windowFailureRate: 0.5,
};

describe("GET /admin/providers", () => {
  it("returns 401 when no admin session is present", async () => {
    rejectAs(401, "Authentication required");
    const res = await app.inject({ method: "GET", url: "/admin/providers" });
    expect(res.statusCode).toBe(401);
    expect(providerHealthMock.getAll).not.toHaveBeenCalled();
  });

  it("returns 200 with sorted providers for an administrator", async () => {
    providerHealthMock.getAll.mockResolvedValue({
      zeta: { ...sampleState },
      alpha: { ...sampleState, successCount: 5 },
    });
    const res = await app.inject({ method: "GET", url: "/admin/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { providers: Array<{ id: string }> };
    expect(body.providers.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });

  it("round-trips actual serialized provider output through the generated browser operation", async () => {
    providerHealthMock.getAll.mockResolvedValue({ provider: { ...sampleState } });
    const sdkApp = Fastify();
    const { adminProviderHealthRoute } = await import("../admin-provider-health.js");
    await sdkApp.register(adminProviderHealthRoute, { prefix: "/api" });
    const fetch = vi.fn(administrationSdkFetch(sdkApp));
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await listAdminProviderHealth({
        client: createApiClient({ baseUrl: "https://app.test", credentials: "include" }),
      });
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error("Expected provider response");
      expect(result.data).toEqual({ providers: [{ id: "provider", ...sampleState }] });
      expect(result.data.providers[0]?.lastFailureAt).toBe("2026-05-21T00:00:30.000Z");
      expect(result.data.providers[0]?.window[0]?.latencyMs).toBe(80);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/api/admin/providers");
      expect(fetch.mock.calls[0]?.[1]?.credentials).toBe("include");
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
    } finally {
      await sdkApp.close();
    }
  });
});

describe("GET /admin/providers/:id", () => {
  it("returns 200 + state when the provider exists", async () => {
    providerHealthMock.getState.mockResolvedValue({
      ...sampleState,
      state: "half-open",
      retryAt: "2026-05-21T00:05:30.000Z",
    });

    const res = await app.inject({ method: "GET", url: "/admin/providers/acme" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "acme", state: "half-open", successCount: 12 });
  });

  it("returns 404 when the provider is unknown", async () => {
    providerHealthMock.getState.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/admin/providers/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /admin/providers/:id/reset", () => {
  it("returns 200, clears state and records the reset for an administrator", async () => {
    providerHealthMock.reset.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/admin/providers/acme/reset" });
    expect(res.statusCode).toBe(200);
    expect(providerHealthMock.reset).toHaveBeenCalledWith("acme");
    expect(res.json()).toEqual({ ok: true, providerId: "acme" });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "provider.reset",
        targetId: "acme",
      }),
    );
  });

  it("returns 403 for a signed-in user who is not an administrator", async () => {
    rejectAs(403, "Admin access required");

    const res = await app.inject({ method: "POST", url: "/admin/providers/acme/reset" });
    expect(res.statusCode).toBe(403);
    expect(providerHealthMock.reset).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns 401 when no admin session is present", async () => {
    rejectAs(401, "Authentication required");

    const res = await app.inject({ method: "POST", url: "/admin/providers/acme/reset" });
    expect(res.statusCode).toBe(401);
    expect(providerHealthMock.reset).not.toHaveBeenCalled();
  });
});
