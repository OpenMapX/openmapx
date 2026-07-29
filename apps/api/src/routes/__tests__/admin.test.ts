import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

// Rate limiters — no-op
vi.mock("../../utils/rate-limit.js", () => ({
  healthCheckSweepLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  serviceActionLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  storeInstallLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  emailTestLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  publicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  authLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  expensivePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  tilePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

// Job runner
const mockJobRunnerEnqueue = vi.fn().mockResolvedValue("job-main-123");
const mockJobRunnerCancel = vi.fn().mockResolvedValue(true);
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: {
    enqueue: (...args: unknown[]) => mockJobRunnerEnqueue(...args),
    cancel: (...args: unknown[]) => mockJobRunnerCancel(...args),
  },
}));

const mockListActivityJobs = vi.fn().mockResolvedValue({ jobs: [], total: 0 });
const mockGetActivityJob = vi.fn().mockResolvedValue(null);
vi.mock("../../services/activity-jobs.js", () => ({
  listActivityJobs: (...args: unknown[]) => mockListActivityJobs(...args),
  getActivityJob: (...args: unknown[]) => mockGetActivityJob(...args),
}));

// DB — multiple tables used across admin.ts
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();

function makeSelectChain(resolveWith: unknown[] = []) {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(resolveWith).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};

mockDbSelect.mockImplementation(() => makeSelectChain());
mockDbInsert.mockReturnValue(insertChain);

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));

vi.mock("../../db/schema.js", () => ({
  user: { id: "id", banned: "banned" },
  session: { id: "id", userId: "userId", updatedAt: "updatedAt" },
  adminAuditLog: {
    id: "id",
    action: "action",
    actorId: "actorId",
    targetType: "targetType",
    targetId: "targetId",
    createdAt: "createdAt",
  },
  adminJob: {
    id: "id",
    type: "type",
    status: "status",
    createdAt: "createdAt",
    finishedAt: "finishedAt",
    createdBy: "createdBy",
    error: "error",
  },
  adminJobLog: { jobId: "jobId", seq: "seq" },
  integrationConfig: { id: "id", integrationId: "integrationId", config: "config" },
}));

// Integration host
const MOCK_INTEGRATION = {
  id: "geocoding-maptiler",
  enabled: true,
  isBuiltIn: true,
  directory: "/integrations/geocoding-maptiler",
  manifest: {
    name: "MapTiler Geocoding",
    description: "Geocoding via MapTiler",
    version: "1.0.0",
    author: "OpenMapX",
    license: "AGPL-3.0",
    documentation: null,
    domains: ["geocoding"],
    quality: "stable",
    healthCheck: null,
    dependencies: [],
    requires: [],
    infrastructure: null,
    configSchema: undefined,
  },
  strings: { en: { name: "MapTiler Geocoding" } },
};

const mockGetAllIntegrations = vi.fn().mockReturnValue([MOCK_INTEGRATION]);
const mockGetIntegration = vi.fn().mockReturnValue(MOCK_INTEGRATION);
const mockReloadIntegrations = vi
  .fn()
  .mockResolvedValue({ reloaded: 1, failed: 0, integrations: [] });
const mockResolveConfigWithSources = vi.fn().mockResolvedValue({});

vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: (...args: unknown[]) => mockGetAllIntegrations(...args),
  getIntegration: (...args: unknown[]) => mockGetIntegration(...args),
  reloadIntegrations: (...args: unknown[]) => mockReloadIntegrations(...args),
  resolveConfigWithSources: (...args: unknown[]) => mockResolveConfigWithSources(...args),
}));

// Health services
const mockGetCachedHealthStatus = vi.fn().mockReturnValue(null);
const mockExecuteIntegrationHealthCheck = vi.fn().mockResolvedValue([]);
const mockExecuteAllIntegrationHealthChecks = vi.fn().mockResolvedValue([]);

vi.mock("../../services/integration-health.js", () => ({
  getCachedHealthStatus: (...args: unknown[]) => mockGetCachedHealthStatus(...args),
  executeIntegrationHealthCheck: (...args: unknown[]) => mockExecuteIntegrationHealthCheck(...args),
  executeAllIntegrationHealthChecks: (...args: unknown[]) =>
    mockExecuteAllIntegrationHealthChecks(...args),
}));

// Health history
vi.mock("../../services/health-history.js", () => ({
  getTimeline: vi.fn().mockResolvedValue([]),
}));

// Secrets
const mockIsSecretsConfigured = vi.fn().mockReturnValue(true);
const mockListAllSecrets = vi.fn().mockResolvedValue([]);
const mockListSecrets = vi.fn().mockResolvedValue([]);
const mockSetSecret = vi.fn().mockResolvedValue(undefined);
const mockDeleteSecret = vi.fn().mockResolvedValue(undefined);

vi.mock("../../services/secrets.js", () => ({
  isSecretsConfigured: (...args: unknown[]) => mockIsSecretsConfigured(...args),
  listAllSecrets: (...args: unknown[]) => mockListAllSecrets(...args),
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  setSecret: (...args: unknown[]) => mockSetSecret(...args),
  deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
}));

// Docker compose
const mockDockerComposePs = vi.fn().mockResolvedValue([]);
vi.mock("../../utils/docker-compose.js", () => ({
  dockerComposePs: (...args: unknown[]) => mockDockerComposePs(...args),
}));

// Admin ops
vi.mock("../../services/admin-ops.js", () => ({
  isDockerAvailable: vi.fn().mockResolvedValue(false),
}));

// validate-config-body
const mockGetSecretFields = vi.fn().mockReturnValue([]);
vi.mock("../../utils/validate-config-body.js", () => ({
  validateConfigBody: vi.fn().mockReturnValue({ updates: {}, errors: [] }),
  getSecretFields: (...args: unknown[]) => mockGetSecretFields(...args),
}));

// resolve-actor
vi.mock("../../utils/resolve-actor.js", () => ({
  resolveActors: vi.fn().mockResolvedValue(new Map()),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminRoute } = await import("../admin.js");
  app = Fastify({ logger: false });
  await app.register(adminRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());

describe("GET /admin/overview", () => {
  it("returns system health overview with integration stats", async () => {
    // DB queries in overview: user count, banned count, active sessions, and
    // recent audit. The default chains resolve to [] and the handler uses
    // `?? 0` fallbacks; activity jobs use the service mock above.
    const res = await app.inject({ method: "GET", url: "/admin/overview" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.systemHealth).toBeDefined();
    expect(body.systemHealth.status).toBe("pass");
    expect(body.users).toMatchObject({ total: 0, active24h: 0, banned: 0 });
    expect(body.integrations).toMatchObject({ total: 1, enabled: 1 });
  });

  it("includes data-manager jobs and surfaces their failures", async () => {
    mockListActivityJobs.mockResolvedValueOnce({
      total: 1,
      jobs: [
        {
          source: "data-manager",
          id: "job-dm",
          type: "transitous-sync",
          status: "failed",
          error: null,
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/admin/overview" });

    expect(res.statusCode).toBe(200);
    expect(res.json().activeJobs).toEqual([
      expect.objectContaining({ source: "data-manager", id: "job-dm" }),
    ]);
    expect(res.json().attention).toContainEqual(
      expect.objectContaining({ type: "job_failed", target: "job-dm" }),
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );

    const res = await app.inject({ method: "GET", url: "/admin/overview" });

    expect(res.statusCode).toBe(401);
  });
});

describe("GET /admin/integrations", () => {
  it("returns integration list with enabled, configured, and health fields", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/integrations" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "geocoding-maptiler",
      enabled: true,
      configured: true,
      hasHealthCheck: false,
    });
  });
});

describe("GET /admin/integrations/:id", () => {
  it("returns integration detail for known id", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/integrations/geocoding-maptiler" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("geocoding-maptiler");
    expect(body.credentialStatus).toBeDefined();
  });

  it("returns 404 for unknown integration id", async () => {
    mockGetIntegration.mockReturnValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/admin/integrations/unknown-integration" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Integration not found");
  });
});

describe("POST /admin/integrations/health/run", () => {
  it("runs a fresh health sweep for enabled integrations", async () => {
    mockExecuteAllIntegrationHealthChecks.mockResolvedValueOnce([
      { id: "geocoding-maptiler", status: "up" },
    ]);

    const res = await app.inject({ method: "POST", url: "/admin/integrations/health/run" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 1, results: [{ id: "geocoding-maptiler" }] });
    expect(mockExecuteAllIntegrationHealthChecks).toHaveBeenCalledWith([MOCK_INTEGRATION]);
  });
});

describe("POST /admin/integrations/:id/enable", () => {
  it("enables an integration, writes audit log, and returns reload result", async () => {
    // DB select for existing config returns empty (no pre-existing config row)
    mockDbSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }));

    const res = await app.inject({
      method: "POST",
      url: "/admin/integrations/geocoding-maptiler/enable",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "integration.enabled", targetId: "geocoding-maptiler" }),
    );
    expect(mockReloadIntegrations).toHaveBeenCalled();
  });

  it("returns 404 for unknown integration", async () => {
    mockGetIntegration.mockReturnValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/admin/integrations/no-such-integration/enable",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /admin/jobs", () => {
  it("returns jobs list with total count", async () => {
    mockListActivityJobs.mockResolvedValueOnce({ jobs: [], total: 3 });

    const res = await app.inject({ method: "GET", url: "/admin/jobs?status=active&limit=25" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobs).toBeDefined();
    expect(body.total).toBe(3);
    expect(mockListActivityJobs).toHaveBeenCalledWith({ filter: "active", limit: 25, offset: 0 });
  });

  it("rejects an unknown status group", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/jobs?status=running" });

    expect(res.statusCode).toBe(400);
    expect(mockListActivityJobs).not.toHaveBeenCalled();
  });
});

describe("GET /admin/jobs/:id", () => {
  it("loads a source-aware data-manager job detail", async () => {
    mockGetActivityJob.mockResolvedValueOnce({
      source: "data-manager",
      id: "job-dm",
      status: "running",
      stages: [],
      logs: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/jobs/job-dm?source=data-manager",
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetActivityJob).toHaveBeenCalledWith("job-dm", "data-manager");
  });

  it("rejects an unknown job source", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/jobs/job-dm?source=other" });

    expect(res.statusCode).toBe(400);
    expect(mockGetActivityJob).not.toHaveBeenCalled();
  });
});

describe("POST /admin/jobs/:id/cancel", () => {
  it("cancels a job and writes audit log", async () => {
    mockJobRunnerCancel.mockResolvedValueOnce(true);

    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/job-abc/cancel",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockJobRunnerCancel).toHaveBeenCalledWith("job-abc");
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "job.cancel", targetId: "job-abc" }),
    );
  });

  it("returns 400 when job cannot be canceled", async () => {
    mockJobRunnerCancel.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/already-done/cancel",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cannot be canceled");
  });

  it("does not offer application cancellation for data-manager jobs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/job-dm/cancel?source=data-manager",
    });

    expect(res.statusCode).toBe(400);
    expect(mockJobRunnerCancel).not.toHaveBeenCalled();
  });

  it("rejects cancellation for an unknown job source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/jobs/job-abc/cancel?source=other",
    });

    expect(res.statusCode).toBe(400);
    expect(mockJobRunnerCancel).not.toHaveBeenCalled();
  });
});

describe("GET /admin/audit", () => {
  it("returns audit log entries with total", async () => {
    // Same two-query pattern as /admin/jobs
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? makeSelectChain([]) : makeSelectChain([{ total: 7 }]);
    });

    const res = await app.inject({ method: "GET", url: "/admin/audit" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toBeDefined();
    expect(body.total).toBe(7);
  });
});

describe("GET /admin/audit/export", () => {
  function auditRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt-1",
      actorId: "user-1",
      action: "user.ban",
      targetType: "user",
      targetId: "user-99",
      details: { reason: "spam" },
      ipAddress: "127.0.0.1",
      createdAt: new Date("2026-06-17T12:00:00.000Z"),
      ...overrides,
    };
  }

  it("exports JSON with the audit rows array", async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([auditRow()]));

    const res = await app.inject({ method: "GET", url: "/admin/audit/export?format=json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ action: "user.ban", targetId: "user-99" });
  });

  it("exports CSV with the fixed columns and RFC-4180 escaping", async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([
        auditRow({
          action: 'weird,"action"',
          targetId: "line\nbreak",
        }),
      ]),
    );

    const res = await app.inject({ method: "GET", url: "/admin/audit/export?format=csv" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const text = res.body;
    // Header is the first physical line; the data row spans a wrapped line
    // because the targetId field contains a real newline inside its quotes.
    expect(text.startsWith("createdAt,actorId,action,targetType,targetId\n")).toBe(true);
    // createdAt serialized as ISO, comma/quote/newline fields quoted+escaped
    expect(text).toContain("2026-06-17T12:00:00.000Z");
    expect(text).toContain('"weird,""action"""');
    expect(text).toContain('"line\nbreak"');
    // details must NOT appear in CSV
    expect(text).not.toContain("spam");
  });

  it("caps at 10,000 rows and sets X-Export-Truncated when exceeded", async () => {
    const oversized = Array.from({ length: 10_001 }, (_, i) => auditRow({ id: `evt-${i}` }));
    mockDbSelect.mockImplementationOnce(() => makeSelectChain(oversized));

    const res = await app.inject({ method: "GET", url: "/admin/audit/export?format=json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-export-truncated"]).toBe("true");
    expect(res.json()).toHaveLength(10_000);
  });

  it("does not set X-Export-Truncated when within the cap", async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([auditRow()]));

    const res = await app.inject({ method: "GET", url: "/admin/audit/export?format=json" });

    expect(res.headers["x-export-truncated"]).toBeUndefined();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );

    const res = await app.inject({ method: "GET", url: "/admin/audit/export?format=json" });

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /admin/integrations/reload", () => {
  it("enqueues integration reload job and writes audit log", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/integrations/reload" });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "integration.reload",
      {},
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "integration.reload.all" }),
    );
  });
});

describe("PUT /admin/credentials/:integrationId/:key", () => {
  it("stores the secret AND reloads so the running integration picks it up", async () => {
    mockGetSecretFields.mockReturnValueOnce([{ key: "apiKey", title: "API Key" }]);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/credentials/fuel/apiKey",
      payload: { value: "secret-value" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockSetSecret).toHaveBeenCalledWith(
      "fuel",
      "apiKey",
      "secret-value",
      fakeSession.user.id,
    );
    // The crux: without this reload the freshly-vaulted key never reaches the
    // provider (config is captured once at setup() load time).
    expect(mockReloadIntegrations).toHaveBeenCalled();
  });
});

describe("DELETE /admin/credentials/:integrationId/:key", () => {
  it("deletes the secret AND reloads", async () => {
    const res = await app.inject({ method: "DELETE", url: "/admin/credentials/fuel/apiKey" });

    expect(res.statusCode).toBe(200);
    expect(mockDeleteSecret).toHaveBeenCalledWith("fuel", "apiKey");
    expect(mockReloadIntegrations).toHaveBeenCalled();
  });
});
