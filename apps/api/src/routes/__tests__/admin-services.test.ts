import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";

const {
  session: fakeSession,
  requireAdmin: mockRequireAdmin,
  getAdminSession: mockGetAdminSession,
  writeAuditLog: mockWriteAuditLog,
} = installAdminRouteMocks();

// Docker compose helpers
const mockDockerComposePs = vi.fn().mockResolvedValue([]);
const mockDockerComposeLogs = vi.fn((...args: unknown[]) => {
  (args[1] as NodeJS.WritableStream).end();
});
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

const mockExecuteAndWait = vi.fn().mockResolvedValue({ backups: [], warningCount: 0 });
const mockOpsClient = {};
vi.mock("../../services/ops-client.js", () => ({
  createApiOpsClient: () => mockOpsClient,
  createDurableOpsKey: () => `opk1_${"a".repeat(43)}`,
  executeAndWait: (...args: unknown[]) => mockExecuteAndWait(...args),
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
const mockValidateServiceSelectionForWrite = vi.fn().mockReturnValue({ normalized: [] });
const mockAssertValidBackupName = vi.fn();
vi.mock("../../services/admin-cli.js", () => ({
  getServiceSelectionSummary: (...args: unknown[]) => mockGetServiceSelectionSummary(...args),
  listBackupSummaries: (...args: unknown[]) => mockListBackupSummaries(...args),
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
const mockResolveServiceConfigWithSources = vi.fn().mockResolvedValue({});
vi.mock("../../services/service-config-resolver.js", () => ({
  resolveServiceConfigWithSources: (...args: unknown[]) =>
    mockResolveServiceConfigWithSources(...args),
}));

const mockMergeServiceConfig = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/service-config-writer.js", () => ({
  mergeServiceConfig: (...args: unknown[]) => mockMergeServiceConfig(...args),
  readStoredServiceConfig: vi.fn().mockResolvedValue(null),
  restoreStoredServiceConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/trusted-config-operations.js", () => ({
  applyTrustedConfiguration: vi.fn().mockResolvedValue({ revisionId: "revision_1" }),
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
const mockValidateConfigBody = vi.fn().mockReturnValue({ updates: {}, errors: [] });
vi.mock("../../utils/validate-config-body.js", async (importActual) => ({
  ...(await importActual<typeof import("../../utils/validate-config-body.js")>()),
  validateConfigBody: (...args: unknown[]) => mockValidateConfigBody(...args),
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
    version: "2.11.0",
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

const MOCK_COMMUNITY_RUNNING = {
  manifest: {
    id: "community-weather",
    name: "Community weather",
    version: "1.0.0",
    description: "Community service",
    quality: "community",
    provides: [],
    exposure: "internal",
  },
  enabled: true,
  isBuiltIn: false,
};

let app: FastifyInstance;

beforeAll(async () => {
  const { adminServicesRoute } = await import("../admin-services.js");
  app = await createAdminTestApp(adminServicesRoute);
});

afterAll(() => app.close());
afterEach(() => {
  vi.clearAllMocks();
  mockRegistryGet.mockReset();
  mockRegistryGet.mockReturnValue(null);
});

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

describe("POST /admin/services/data/action", () => {
  it("enqueues and audits a search-index build", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/services/data/action",
      payload: { operation: "search-index-build", region: "europe/germany" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, jobId: "job-123" });
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "data.operation",
      expect.objectContaining({
        operation: "search-index-build",
        region: "europe/germany",
      }),
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "data",
        targetId: "search-index-build",
        action: "data.search-index-build",
      }),
    );
  });

  it("rejects caller URL/output/argv/environment before fixed API-key generation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/services/data/action",
      payload: {
        operation: "generate-api-keys",
        repoUrl: "https://attacker.example/catalog.git",
        output: "/etc/passwd",
        argv: ["--output", "/etc/passwd"],
        environment: { NODE_OPTIONS: "--require=/tmp/payload" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("rejects operation-inapplicable fields before enqueue", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/services/data/action",
      payload: { operation: "download-fonts", region: "europe/germany" },
    });
    expect(response.statusCode).toBe(400);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
  });
});

describe("strict administrative effect bodies", () => {
  it.each([
    ["/admin/services/bulk-action", { action: "build", all: true, argv: ["--privileged"] }],
    ["/admin/services/backups", { name: "nightly", output: "/etc/passwd" }],
  ])("rejects forbidden control fields on %s", async (url, payload) => {
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});

describe("GET /admin/services/data", () => {
  it("loads a kind-only inventory from ops-agent without passing a host path", async () => {
    const inventory = {
      osm: { found: false },
      builds: [{ target: "valhalla", built: false }],
      motisTransitous: { configFound: false },
    };
    mockExecuteAndWait.mockResolvedValueOnce(inventory);

    const response = await app.inject({ method: "GET", url: "/admin/services/data" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(inventory);
    expect(response.json().fetchedAt).toEqual(expect.any(String));
    expect(mockExecuteAndWait).toHaveBeenCalledWith(
      mockOpsClient,
      { kind: "data.inspect" },
      expect.stringMatching(/^opk1_/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("backup administration", () => {
  it("reads the bounded agent-owned backup inventory through a kind-only request", async () => {
    mockExecuteAndWait.mockResolvedValueOnce({
      backups: [
        {
          backupId: "nightly",
          createdAt: "2026-08-25T00:00:00.000Z",
          platformVersion: "1.2.3",
          serviceCount: 2,
          volumeCount: 3,
          totalBytes: 42,
        },
      ],
      warningCount: 0,
    });

    const response = await app.inject({ method: "GET", url: "/admin/services/backups" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      backups: [
        {
          name: "nightly",
          createdAt: "2026-08-25T00:00:00.000Z",
          openmapxVersion: "1.2.3",
          serviceCount: 2,
          volumeCount: 3,
          totalBytes: 42,
        },
      ],
      warnings: [],
      root: "ops-agent-managed",
    });
    expect(mockExecuteAndWait).toHaveBeenCalledWith(
      mockOpsClient,
      { kind: "backup.list" },
      expect.stringMatching(/^opk1_/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockListBackupSummaries).not.toHaveBeenCalled();
  });

  it("uses the agent inventory for restore admission without exposing a host path", async () => {
    mockExecuteAndWait.mockResolvedValueOnce({
      backups: [
        {
          backupId: "nightly",
          createdAt: "2026-08-25T00:00:00.000Z",
          serviceCount: 1,
          volumeCount: 1,
          totalBytes: 42,
        },
      ],
      warningCount: 0,
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/services/backups/nightly/restore",
      payload: { serviceIds: ["valhalla"], stopRunning: true },
    });
    expect(response.statusCode).toBe(200);
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "backup.operation",
      {
        operation: "restore",
        name: "nightly",
        serviceIds: ["valhalla"],
        stopRunning: true,
      },
      fakeSession.user.id,
    );
    expect(mockListBackupSummaries).not.toHaveBeenCalled();
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

describe("GET /admin/services/:id/logs", () => {
  it("streams community logs through the same typed operation as built-ins", async () => {
    mockRegistryGet.mockReturnValueOnce(MOCK_COMMUNITY_RUNNING);

    const response = await app.inject({
      method: "GET",
      url: "/admin/services/community-weather/logs?lines=20",
      headers: { "idempotency-key": "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1" },
    });

    expect(response.statusCode).toBe(200);
    // The direct-Docker log adapter is gone; community and built-in services
    // both go through the bounded typed follow.
    expect(mockDockerComposeLogs).toHaveBeenCalledWith(
      "community-weather",
      expect.anything(),
      expect.objectContaining({ tail: 20 }),
    );
  });

  it("returns 404 and does not start a log stream for an unknown service", async () => {
    mockRegistryGet.mockReturnValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/admin/services/unknown/logs" });

    expect(res.statusCode).toBe(404);
    expect(mockDockerComposeLogs).not.toHaveBeenCalled();
  });

  it("requires a caller-retained idempotency value before starting an enabled stream", async () => {
    mockRegistryGet.mockReturnValueOnce(MOCK_SERVICE_RUNNING);
    const response = await app.inject({ method: "GET", url: "/admin/services/motis/logs" });
    expect(response.statusCode).toBe(400);
    expect(mockDockerComposeLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["abc", 200],
    ["99999", 1000],
    ["-5", 1],
  ])("clamps lines=%s to a safe tail value", async (lines, tail) => {
    mockRegistryGet.mockReturnValueOnce(MOCK_SERVICE_RUNNING);

    await app.inject({
      method: "GET",
      url: `/admin/services/motis/logs?lines=${lines}`,
      headers: { "idempotency-key": "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1" },
    });

    expect(mockDockerComposeLogs).toHaveBeenCalledWith(
      "motis",
      expect.anything(),
      expect.objectContaining({
        tail,
        operationKey: expect.stringMatching(/^opk1_[A-Za-z0-9_-]{43}$/),
      }),
    );
  });

  it("uses one key for the same admin intent so a changed log payload conflicts at the agent", async () => {
    mockRegistryGet.mockReturnValue(MOCK_SERVICE_RUNNING);
    const headers = { "idempotency-key": "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1" };
    await app.inject({ method: "GET", url: "/admin/services/motis/logs?lines=20", headers });
    await app.inject({ method: "GET", url: "/admin/services/motis/logs?lines=21", headers });
    expect(
      (mockDockerComposeLogs.mock.calls[0]?.[2] as { operationKey?: string })?.operationKey,
    ).toBe((mockDockerComposeLogs.mock.calls[1]?.[2] as { operationKey?: string })?.operationKey);
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

  function managedDawarichService(serviceId: string, key: string) {
    return {
      manifest: {
        id: serviceId,
        name: serviceId,
        version: "1.10.3",
        quality: "built-in",
        configSchema: {
          properties: {
            [key]: {
              type: "string",
              title: key,
              "x-openmapx-secret": true,
            },
          },
        },
      },
      enabled: true,
      isBuiltIn: true,
    };
  }

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
    mockResolveServiceConfigWithSources.mockReset().mockResolvedValue({});
    mockValidateConfigBody.mockReset().mockReturnValue({ updates: {}, errors: [] });
    mockMergeServiceConfig.mockReset().mockResolvedValue(undefined);
  });

  describe("GET /admin/services/:id/config", () => {
    it("masks declared secrets while preserving the response shape", async () => {
      mockResolveServiceConfigWithSources.mockResolvedValueOnce({
        NY_511_API_KEY: { value: "placeholder-not-a-real-value", source: "env" },
        RATE_LIMIT_MAX: { value: 120, source: "default" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/admin/services/openconditions-ingest/config",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.resolvedConfig.NY_511_API_KEY).toEqual({ value: "***", source: "env" });
      expect(body.resolvedConfig.RATE_LIMIT_MAX.value).toBe(120);
      expect(res.payload).not.toContain("placeholder-not-a-real-value");
      expect(body.schema).toEqual(SECRET_SERVICE.manifest.configSchema);
      expect(body.envPrefix).toBe("SERVICE_ID");
    });
  });

  describe("POST /admin/services/:id/config", () => {
    it("persists only the route-validated update through the atomic writer", async () => {
      mockValidateConfigBody.mockReturnValueOnce({
        updates: { RATE_LIMIT_MAX: 240 },
        errors: [],
      });

      const res = await app.inject({
        method: "POST",
        url: "/admin/services/openconditions-ingest/config",
        payload: { config: { RATE_LIMIT_MAX: 240, UNKNOWN: "discarded" } },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMergeServiceConfig).toHaveBeenCalledWith("openconditions-ingest", {
        RATE_LIMIT_MAX: 240,
      });
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
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

  it("GET marks provisioning-owned Dawarich credentials as managed", async () => {
    mockRegistryGet.mockReturnValueOnce(
      managedDawarichService("dawarich-app", "OIDC_CLIENT_SECRET"),
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/services/dawarich-app/credentials",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toEqual([
      expect.objectContaining({
        key: "OIDC_CLIENT_SECRET",
        managedBy: "dawarich-provisioning",
      }),
    ]);
  });

  it.each([
    ["dawarich-app", "DATABASE_PASSWORD"],
    ["dawarich-app", "SECRET_KEY_BASE"],
    ["dawarich-app", "OIDC_CLIENT_SECRET"],
    ["dawarich-sidekiq", "DATABASE_PASSWORD"],
    ["dawarich-sidekiq", "SECRET_KEY_BASE"],
    ["dawarich-sidekiq", "OIDC_CLIENT_SECRET"],
    ["dawarich-postgis", "POSTGRES_PASSWORD"],
  ])("rejects generic PUT/DELETE for managed %s:%s", async (serviceId, key) => {
    mockRegistryGet.mockReturnValue(managedDawarichService(serviceId, key));

    const [put, remove] = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/admin/services/${serviceId}/credentials/${key}`,
        payload: { value: "must-not-be-written" },
      }),
      app.inject({
        method: "DELETE",
        url: `/admin/services/${serviceId}/credentials/${key}`,
      }),
    ]);

    for (const response of [put, remove]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "DAWARICH_CREDENTIAL_MANAGED",
      });
      expect(response.json().error).toMatch(/Managed Dawarich setup/i);
    }
    expect(mockSetServiceSecret).not.toHaveBeenCalled();
    expect(mockDeleteServiceSecret).not.toHaveBeenCalled();
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("rejects concurrent generic writes without bypassing managed ownership", async () => {
    mockRegistryGet.mockImplementation((serviceId: string) =>
      managedDawarichService(serviceId, "DATABASE_PASSWORD"),
    );

    const responses = await Promise.all(
      ["dawarich-app", "dawarich-sidekiq"].map((serviceId) =>
        app.inject({
          method: "PUT",
          url: `/admin/services/${serviceId}/credentials/DATABASE_PASSWORD`,
          payload: { value: "same-but-unsafe" },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([409, 409]);
    expect(mockSetServiceSecret).not.toHaveBeenCalled();
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
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
      { service: "openconditions-ingest", configurationKind: "vault" },
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

  it("PUT rejects a percent-encoded traversal key", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/services/openconditions-ingest/credentials/..%2F..%2Fescaped",
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
      { service: "openconditions-ingest", configurationKind: "vault" },
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.credential.delete" }),
    );
  });

  it("DELETE rejects a percent-encoded traversal key", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/services/openconditions-ingest/credentials/..%2F..%2Fescaped",
    });

    expect(res.statusCode).toBe(400);
    expect(mockDeleteServiceSecret).not.toHaveBeenCalled();
  });

  it("DELETE rejects a key that is neither declared nor stored", async () => {
    mockListServiceSecrets.mockResolvedValue([]);

    const res = await app.inject({
      method: "DELETE",
      url: "/admin/services/openconditions-ingest/credentials/RATE_LIMIT_MAX",
    });

    expect(res.statusCode).toBe(400);
    expect(mockDeleteServiceSecret).not.toHaveBeenCalled();
  });

  it("DELETE still removes a stored key the manifest no longer declares", async () => {
    mockListServiceSecrets.mockResolvedValue([
      { key: "LEGACY_KEY", updatedAt: new Date(), updatedBy: "u1" },
    ]);

    const res = await app.inject({
      method: "DELETE",
      url: "/admin/services/openconditions-ingest/credentials/LEGACY_KEY",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDeleteServiceSecret).toHaveBeenCalledWith("openconditions-ingest", "LEGACY_KEY");
  });
});
