import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

const fakeSession = mockAdminSession();
const mockRequireAdmin = vi.fn().mockResolvedValue(fakeSession);
const mockGetAdminSession = vi.fn().mockReturnValue(fakeSession);
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
}));

vi.mock("../../utils/rate-limit.js", () => ({
  serviceActionLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

const bundle = new Map([
  [
    "dawarich-app",
    {
      manifest: {
        id: "dawarich-app",
        version: "1.10.3",
        container: { image: "freikin/dawarich", tag: "1.10.3" },
      },
    },
  ],
  [
    "dawarich-sidekiq",
    {
      manifest: {
        id: "dawarich-sidekiq",
        version: "1.10.3",
        container: { image: "freikin/dawarich", tag: "1.10.3" },
      },
    },
  ],
  [
    "dawarich-postgis",
    {
      manifest: {
        id: "dawarich-postgis",
        version: "17-3.5",
        container: { image: "ghcr.io/baosystems/postgis", tag: "17-3.5" },
      },
    },
  ],
  [
    "dawarich-redis",
    {
      manifest: {
        id: "dawarich-redis",
        version: "7.4",
        container: { image: "redis", tag: "7.4-alpine" },
      },
    },
  ],
]);
const mockRegistryGet = vi.fn((id: string) => bundle.get(id));
vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: () => ({ get: (id: string) => mockRegistryGet(id) }),
}));

const safeStatus = {
  installed: true,
  selected: false,
  running: false,
  healthy: false,
  publicOrigin: "https://timeline.example.test",
  oauthClient: {
    present: true,
    clientId: "client-public-id",
    redirectUriMatches: true,
    settingsMatch: true,
  },
  secrets: {
    databasePassword: "consistent",
    secretKeyBase: "consistent",
    oidcClientSecret: "consistent",
  },
  configReady: true,
  readyToStart: true,
  needsApply: true,
};
const mockInspect = vi.fn().mockResolvedValue(safeStatus);
const mockProvision = vi.fn().mockResolvedValue({
  status: safeStatus,
  audit: {
    hostname: "timeline.example.test",
    created: true,
    reconciled: false,
    rotated: false,
    outcome: "success",
  },
});
const mockRotate = vi.fn().mockResolvedValue({
  status: safeStatus,
  audit: {
    hostname: "timeline.example.test",
    created: false,
    reconciled: false,
    rotated: true,
    outcome: "success",
  },
});
class MockProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
vi.mock("../../services/dawarich/provisioning.js", async (importActual) => ({
  ...(await importActual<typeof import("../../services/dawarich/provisioning.js")>()),
  ManagedDawarichProvisioningError: MockProvisioningError,
  inspectManagedDawarichProvisioning: (...args: unknown[]) => mockInspect(...args),
  provisionManagedDawarich: (...args: unknown[]) => mockProvision(...args),
  rotateManagedDawarichOidcSecret: (...args: unknown[]) => mockRotate(...args),
}));

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DOMAIN = "example.test";
  const { adminDawarichRoute } = await import("../admin-dawarich.js");
  app = Fastify({ logger: false });
  await app.register(adminDawarichRoute);
  await app.ready();
});

afterAll(async () => {
  delete process.env.DOMAIN;
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(fakeSession);
  mockGetAdminSession.mockReturnValue(fakeSession);
  mockRegistryGet.mockImplementation((id: string) => bundle.get(id));
  mockInspect.mockResolvedValue(safeStatus);
  mockProvision.mockResolvedValue({
    status: safeStatus,
    audit: {
      hostname: "timeline.example.test",
      created: true,
      reconciled: false,
      rotated: false,
      outcome: "success",
    },
  });
  mockRotate.mockResolvedValue({
    status: safeStatus,
    audit: {
      hostname: "timeline.example.test",
      created: false,
      reconciled: false,
      rotated: true,
      outcome: "success",
    },
  });
});

describe("admin Dawarich provisioning routes", () => {
  it("requires an authenticated administrator", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const response = await app.inject({ method: "GET", url: "/admin/dawarich" });
    expect(response.statusCode).toBe(401);
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it("returns only the safe read-only provisioning status", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/dawarich" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(safeStatus);
    expect(mockProvision).not.toHaveBeenCalled();
    expect(response.payload).not.toContain("sensitive");
  });

  it("validates the exact installed bundle before provisioning mutation", async () => {
    mockRegistryGet.mockImplementation((id: string) =>
      id === "dawarich-postgis" ? undefined : bundle.get(id),
    );
    const response = await app.inject({
      method: "POST",
      url: "/admin/dawarich/provision",
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "DAWARICH_BUNDLE_NOT_INSTALLED" });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("provisions without starting services and audits only redacted facts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/dawarich/provision",
      payload: { publicHost: "timeline.example.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(safeStatus);
    expect(mockProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: fakeSession.user.id,
        controllerDomain: "example.test",
        publicHost: "timeline.example.test",
        headers: expect.any(Headers),
      }),
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dawarich.provision",
        details: {
          hostname: "timeline.example.test",
          created: true,
          reconciled: false,
          rotated: false,
          outcome: "success",
        },
      }),
    );
    expect(JSON.stringify(mockWriteAuditLog.mock.calls)).not.toContain("secret");
  });

  it.each([
    ["DAWARICH_INVALID_PUBLIC_HOST", 422],
    ["DAWARICH_OAUTH_CLIENT_CONFLICT", 409],
    ["DAWARICH_DATABASE_SECRET_CONFLICT", 409],
    ["DAWARICH_RAILS_SECRET_CONFLICT", 409],
    ["DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED", 503],
    ["DAWARICH_PROVISIONING_FAILED", 503],
  ])("maps %s to a stable redacted HTTP status", async (code, status) => {
    mockProvision.mockRejectedValueOnce(new MockProvisioningError(code));
    const response = await app.inject({
      method: "POST",
      url: "/admin/dawarich/provision",
      payload: { publicHost: "timeline.example.test" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dawarich.provision",
        details: { outcome: "failure", code },
      }),
    );
  });

  it("never serializes unexpected internal exceptions", async () => {
    mockProvision.mockRejectedValueOnce(new Error("database sensitive-marker details"));
    const response = await app.inject({
      method: "POST",
      url: "/admin/dawarich/provision",
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "DAWARICH_PROVISIONING_FAILED" });
    expect(response.payload).not.toContain("sensitive-marker");
    expect(JSON.stringify(mockWriteAuditLog.mock.calls)).not.toContain("sensitive-marker");
  });

  it("requires the exact typed confirmation before OIDC rotation", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/admin/dawarich/rotate-oidc-secret",
      payload: { confirmation: "rotate" },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toEqual({ code: "DAWARICH_ROTATION_CONFIRMATION_REQUIRED" });
    expect(mockRotate).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/admin/dawarich/rotate-oidc-secret",
      payload: { confirmation: "ROTATE DAWARICH OIDC SECRET" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(safeStatus);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dawarich.rotate_oidc_secret",
        details: expect.objectContaining({ rotated: true, outcome: "success" }),
      }),
    );
  });
});
