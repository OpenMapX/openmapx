import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

// Auth guard mock — all three exports required
const fakeSession = mockAdminSession();
const mockRequireAdmin = vi.fn().mockResolvedValue(fakeSession);
const mockGetAdminSession = vi.fn().mockReturnValue(fakeSession);
const mockTryAdminSession = vi.fn().mockResolvedValue(fakeSession);

vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
  tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
}));

// Audit log
const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Docker compose helpers
const mockDockerComposePs = vi.fn().mockResolvedValue([]);
const mockDockerComposeLogs = vi.fn();
vi.mock("../../utils/docker-compose.js", () => ({
  dockerComposePs: (...args: unknown[]) => mockDockerComposePs(...args),
  dockerComposeLogs: (...args: unknown[]) => mockDockerComposeLogs(...args),
}));

// Service registry
const mockRegistryList = vi.fn().mockReturnValue([]);
const mockRegistryGet = vi.fn().mockReturnValue(null);
const mockGetServiceRegistry = vi.fn().mockReturnValue({
  list: mockRegistryList,
  get: mockRegistryGet,
});
vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: (...args: unknown[]) => mockGetServiceRegistry(...args),
}));

// Job runner
const mockJobRunnerEnqueue = vi.fn().mockResolvedValue("job-123");
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: { enqueue: (...args: unknown[]) => mockJobRunnerEnqueue(...args) },
}));

// DB (needed for service config routes)
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const dbChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};
mockDbSelect.mockReturnValue(dbChain);
mockDbInsert.mockReturnValue(dbChain);
vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));
vi.mock("../../db/schema.js", () => ({
  serviceConfig: { serviceId: "serviceId", config: "config" },
}));

// admin-cli helpers
const mockGetServiceSelectionSummary = vi.fn().mockReturnValue({
  selectedRoots: [],
  effectiveIds: [],
});
const mockListBackupSummaries = vi
  .fn()
  .mockReturnValue({ backups: [], warnings: [], root: "/data" });
const mockWriteServiceSelection = vi.fn().mockReturnValue("/data/service-selection.json");
const mockValidateServiceSelectionForWrite = vi.fn().mockReturnValue({ normalized: [] });
const mockAssertValidBackupName = vi.fn();
vi.mock("../../services/admin-cli.js", () => ({
  getServiceSelectionSummary: (...args: unknown[]) => mockGetServiceSelectionSummary(...args),
  listBackupSummaries: (...args: unknown[]) => mockListBackupSummaries(...args),
  writeServiceSelection: (...args: unknown[]) => mockWriteServiceSelection(...args),
  validateServiceSelectionForWrite: (...args: unknown[]) =>
    mockValidateServiceSelectionForWrite(...args),
  assertValidBackupName: (...args: unknown[]) => mockAssertValidBackupName(...args),
}));

// Rate limiter — no-op the preHandler
vi.mock("../../utils/rate-limit.js", () => ({
  serviceActionLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  storeInstallLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  emailTestLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  publicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  authLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  expensivePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  tilePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

// Resolve service config (service config GET uses this)
vi.mock("../../services/service-config-resolver.js", () => ({
  resolveServiceConfigWithSources: vi.fn().mockResolvedValue({}),
}));

// @openmapx/core/server — getProvidedCapabilityNames + serviceConfigEnvPrefix
vi.mock("@openmapx/core/server", () => ({
  services: {
    getProvidedCapabilityNames: vi.fn().mockReturnValue([]),
    serviceConfigEnvPrefix: vi.fn().mockReturnValue("SERVICE_ID"),
  },
}));

// validate-config-body — keep the real `getSecretFields` (pure), mock only the
// config validator.
vi.mock("../../utils/validate-config-body.js", async (importActual) => ({
  ...(await importActual<typeof import("../../utils/validate-config-body.js")>()),
  validateConfigBody: vi.fn().mockReturnValue({ updates: {}, errors: [] }),
}));

// Service secret vault + apply plumbing
const mockIsSecretsConfigured = vi.fn().mockReturnValue(true);
vi.mock("../../services/secrets.js", () => ({
  isSecretsConfigured: (...args: unknown[]) => mockIsSecretsConfigured(...args),
}));

const mockIsDockerAvailable = vi.fn().mockResolvedValue(true);
vi.mock("../../services/admin-ops.js", () => ({
  isDockerAvailable: (...args: unknown[]) => mockIsDockerAvailable(...args),
}));

const mockSetServiceSecret = vi.fn().mockResolvedValue(undefined);
const mockDeleteServiceSecret = vi.fn().mockResolvedValue(undefined);
const mockListServiceSecrets = vi.fn().mockResolvedValue([]);
vi.mock("../../services/service-secrets.js", () => ({
  setServiceSecret: (...args: unknown[]) => mockSetServiceSecret(...args),
  deleteServiceSecret: (...args: unknown[]) => mockDeleteServiceSecret(...args),
  listServiceSecrets: (...args: unknown[]) => mockListServiceSecrets(...args),
}));

// Fixtures
const MOCK_SERVICE_RUNNING = {
  manifest: {
    id: "motis",
    name: "MOTIS",
    version: "2.10.2",
    description: "Transit routing engine",
    quality: "stable",
    provides: [],
    exposure: "internal",
  },
  enabled: true,
  isBuiltIn: true,
};

const MOCK_SERVICE_STOPPED = {
  manifest: {
    id: "valhalla",
    name: "Valhalla",
    version: "3.4.0",
    description: "Street routing",
    quality: "stable",
    provides: [],
    exposure: "internal",
  },
  enabled: true,
  isBuiltIn: true,
};

let app: FastifyInstance;

beforeAll(async () => {
  const { adminServicesRoute } = await import("../admin-services.js");
  app = Fastify({ logger: false });
  await app.register(adminServicesRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());

describe("GET /admin/services", () => {
  it("returns running/stopped summary with normalised service fields", async () => {
    mockRegistryList.mockReturnValueOnce([MOCK_SERVICE_RUNNING, MOCK_SERVICE_STOPPED]);
    mockDockerComposePs.mockResolvedValueOnce([{ service: "motis", state: "running" }]);

    const res = await app.inject({ method: "GET", url: "/admin/services" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ running: 1, stopped: 1, total: 2 });
    expect(body.services).toHaveLength(2);
    const motis = body.services.find((s: { id: string }) => s.id === "motis");
    expect(motis).toMatchObject({ id: "motis", status: "running", enabled: true });
    const valhalla = body.services.find((s: { id: string }) => s.id === "valhalla");
    expect(valhalla).toMatchObject({ id: "valhalla", status: "not-running" });
  });

  it("returns empty summary when registry has no services", async () => {
    mockRegistryList.mockReturnValueOnce([]);
    mockDockerComposePs.mockResolvedValueOnce([]);

    const res = await app.inject({ method: "GET", url: "/admin/services" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ running: 0, stopped: 0, total: 0 });
    expect(body.services).toHaveLength(0);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );

    const res = await app.inject({ method: "GET", url: "/admin/services" });

    expect(res.statusCode).toBe(401);
  });
});

describe("GET /admin/services/:id", () => {
  it("returns 404 for unknown service id", async () => {
    mockRegistryGet.mockReturnValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/admin/services/unknown-service" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Service not found");
  });

  it("returns service detail with docker status", async () => {
    mockRegistryGet.mockReturnValueOnce(MOCK_SERVICE_RUNNING);
    mockDockerComposePs.mockResolvedValueOnce([{ service: "motis", state: "running" }]);

    const res = await app.inject({ method: "GET", url: "/admin/services/motis" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ manifest: { id: "motis" }, status: "running" });
  });
});

describe("POST /admin/services/:id/action", () => {
  it("enqueues action, writes audit log, and returns jobId", async () => {
    mockRegistryGet.mockReturnValueOnce(MOCK_SERVICE_RUNNING);
    mockGetAdminSession.mockReturnValue(fakeSession);
    mockJobRunnerEnqueue.mockResolvedValueOnce("job-abc");

    const res = await app.inject({
      method: "POST",
      url: "/admin/services/motis/action",
      payload: { action: "restart" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, jobId: "job-abc" });
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "service.restart",
      { service: "motis" },
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: fakeSession.user.id,
        targetId: "motis",
        action: "service.restart",
      }),
    );
  });

  it("returns 404 for unknown service id", async () => {
    mockRegistryGet.mockReturnValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/admin/services/unknown-svc/action",
      payload: { action: "start" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 for invalid action", async () => {
    mockRegistryGet.mockReturnValueOnce(MOCK_SERVICE_RUNNING);

    const res = await app.inject({
      method: "POST",
      url: "/admin/services/motis/action",
      payload: { action: "explode" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid action");
  });
});

describe("GET /admin/services/selection", () => {
  it("returns service selection summary", async () => {
    mockGetServiceSelectionSummary.mockReturnValueOnce({
      selectedRoots: ["motis"],
      effectiveIds: ["motis", "valhalla"],
    });

    const res = await app.inject({ method: "GET", url: "/admin/services/selection" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedRoots).toContain("motis");
    expect(body.effectiveIds).toContain("valhalla");
  });
});

describe("POST /admin/services/check", () => {
  it("runs docker ps, writes audit log, and returns statuses", async () => {
    mockDockerComposePs.mockResolvedValueOnce([{ service: "motis", state: "running" }]);
    mockGetAdminSession.mockReturnValue(fakeSession);

    const res = await app.inject({ method: "POST", url: "/admin/services/check" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.statuses).toEqual([{ service: "motis", state: "running" }]);
    expect(body.checkedAt).toBeTruthy();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.health_check" }),
    );
  });
});

describe("service credentials", () => {
  const SECRET_SERVICE = {
    manifest: {
      id: "openconditions-ingest",
      name: "OpenConditions Ingest",
      version: "0.1.0",
      quality: "community-verified",
      configSchema: {
        properties: {
          NY_511_API_KEY: {
            type: "string",
            title: "511NY API key",
            "x-openmapx-secret": true,
            "x-openmapx-setup": { url: "https://511ny.org/developers" },
          },
          RATE_LIMIT_MAX: { type: "number", default: 120 },
        },
      },
    },
    enabled: true,
    isBuiltIn: false,
  };

  // Reset the shared mocks' queues + implementations so leftover `…Once`
  // values from earlier describes can't leak in (the global afterEach only
  // clears call history, not queued implementations).
  beforeEach(() => {
    mockRegistryGet.mockReset().mockReturnValue(SECRET_SERVICE);
    mockListServiceSecrets.mockReset().mockResolvedValue([]);
    mockIsSecretsConfigured.mockReset().mockReturnValue(true);
    mockIsDockerAvailable.mockReset().mockResolvedValue(true);
    mockSetServiceSecret.mockReset().mockResolvedValue(undefined);
    mockDeleteServiceSecret.mockReset().mockResolvedValue(undefined);
    mockJobRunnerEnqueue.mockReset().mockResolvedValue("job-123");
  });

  it("GET lists declared secret fields with vault/missing status + setup guide", async () => {
    mockListServiceSecrets.mockResolvedValue([
      { key: "NY_511_API_KEY", updatedAt: new Date("2026-06-26T10:00:00Z"), updatedBy: "u1" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/admin/services/openconditions-ingest/credentials",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only the secret field is listed (not the non-secret RATE_LIMIT_MAX).
    expect(body.credentials).toEqual([
      {
        key: "NY_511_API_KEY",
        title: "511NY API key",
        setup: { url: "https://511ny.org/developers" },
        source: "vault",
        updatedAt: "2026-06-26T10:00:00.000Z",
        updatedBy: "u1",
      },
    ]);
    expect(body.secretsConfigured).toBe(true);
  });

  it("PUT stores the secret and enqueues an apply when Docker is available", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/services/openconditions-ingest/credentials/NY_511_API_KEY",
      payload: { value: "secret-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSetServiceSecret).toHaveBeenCalledWith(
      "openconditions-ingest",
      "NY_511_API_KEY",
      "secret-123",
      fakeSession.user.id,
    );
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "service.apply",
      { service: "openconditions-ingest" },
      fakeSession.user.id,
    );
    expect(res.json()).toEqual({ ok: true, jobId: "job-123" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.credential.set" }),
    );
  });

  it("PUT returns needsRender (no apply) when Docker is unavailable", async () => {
    mockIsDockerAvailable.mockResolvedValue(false);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/services/openconditions-ingest/credentials/NY_511_API_KEY",
      payload: { value: "secret-123" },
    });

    expect(res.json()).toEqual({ ok: true, needsRender: true });
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
  });

  it("PUT rejects a key that is not a declared secret field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/services/openconditions-ingest/credentials/RATE_LIMIT_MAX",
      payload: { value: "x" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockSetServiceSecret).not.toHaveBeenCalled();
  });

  it("PUT rejects when the secret vault is not configured", async () => {
    mockIsSecretsConfigured.mockReturnValue(false);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/services/openconditions-ingest/credentials/NY_511_API_KEY",
      payload: { value: "secret-123" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockSetServiceSecret).not.toHaveBeenCalled();
  });

  it("DELETE removes the secret and enqueues an apply", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/services/openconditions-ingest/credentials/NY_511_API_KEY",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDeleteServiceSecret).toHaveBeenCalledWith("openconditions-ingest", "NY_511_API_KEY");
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "service.apply",
      { service: "openconditions-ingest" },
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.credential.delete" }),
    );
  });
});
