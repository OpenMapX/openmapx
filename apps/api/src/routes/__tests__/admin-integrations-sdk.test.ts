import { createApiClient } from "@openmapx/core";
import { integrationAdminOperations } from "@openmapx/core/api-contracts";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationConfig } from "../../db/integration-config-schema";
import { makeRateLimitTierHook } from "../../server-wiring";
import { integrationConfigDbFixture } from "../../services/__tests__/helpers/integration-config-db";
import type { IntegrationImportPorts } from "../../services/integration-config-import";
import { TrustedConfigurationApplyError } from "../../services/trusted-config-outcome";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { healthCheckSweepLimit, RateLimiter, serviceActionLimit } from "../../utils/rate-limit";
import { installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const { requireAdmin: mockRequireAdmin, session: fakeSession } = installAdminRouteMocks();
// Job runner
const mockJobRunnerEnqueue = vi.fn().mockResolvedValue("job-main-123");
const mockJobRunnerCancel = vi.fn().mockResolvedValue(true);
const mockImmediateImport = vi.fn();
const mockImmediateBinding = vi.fn();
const expectedBinding = { expectedServiceId: null, expectedRevision: "a".repeat(64) };
const bindingHeaders = () => {
  serviceActionLimit.reset();
  return { "idempotency-key": crypto.randomUUID() };
};
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: {
    applyImmediateIntegrationBinding: (...args: unknown[]) => mockImmediateBinding(...args),
    enqueue: (...args: unknown[]) => mockJobRunnerEnqueue(...args),
    cancel: (...args: unknown[]) => mockJobRunnerCancel(...args),
    importImmediateIntegrationConfiguration: (...args: unknown[]) => mockImmediateImport(...args),
  },
}));

const configDb = integrationConfigDbFixture();
const mockApplyWithEvidence = vi.fn<IntegrationImportPorts["apply"]>();
const mockCompensate = vi.fn();
const mockApply = vi.fn().mockResolvedValue({ revisionId: "revision_1" });
vi.mock("../../services/trusted-config-operations.js", () => ({
  integrationSchemas: () =>
    new Map([["geocoding-maptiler", MOCK_INTEGRATION.manifest.configSchema]]),
  applyTrustedConfigurationWithEvidence: () => mockApplyWithEvidence(),
  applyTrustedConfigurationSnapshot: (...args: unknown[]) => mockCompensate(...args),
  applyTrustedConfiguration: (...args: unknown[]) => mockApply(...args),
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
const mockDbDelete = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));

function makeSelectChain(resolveWith: unknown[] = []) {
  const chain: Record<string, unknown> = {
    from: vi.fn((table) => (table === integrationConfig ? configDb.db.select().from() : chain)),
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
    transaction: configDb.db.transaction,
    delete: () => mockDbDelete(),
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));

vi.mock("../../db/schema.js", () => ({
  user: { id: "id", banned: "banned" },
  session: { id: "id", userId: "userId", updatedAt: "updatedAt" },
  integrationApplicationReceipt: {
    integrationId: "integration_id",
    createdAt: "created_at",
    result: "result",
  },
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
  integrationConfig,
}));

// Integration host
const MOCK_INTEGRATION = {
  id: "geocoding-maptiler",
  enabled: true,
  isBuiltIn: true,
  directory: "/integrations/geocoding-maptiler",
  manifest: {
    id: "geocoding-maptiler",
    name: "MapTiler Geocoding",
    description: "Geocoding via MapTiler",
    version: "1.0.0",
    author: "OpenMapX",
    licensing: licensingFromDeclaration("AGPL-3.0", undefined),

    domains: ["geocoding"],
    quality: "built-in",

    dependencies: [],
    requires: [{ capability: "routing" }],

    configSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        apiKey: { type: "string", "x-openmapx-secret": true },
        nested: { type: "object", properties: { count: { type: "integer", minimum: 1 } } },
      },
    },
    unfamiliar: { nested: [null, { retained: true }] },
  },
  strings: { en: { name: "MapTiler Geocoding" } },
};

const mockGetAllIntegrations = vi.fn().mockReturnValue([MOCK_INTEGRATION]);
const mockGetIntegration = vi.fn().mockReturnValue(MOCK_INTEGRATION);
const mockReloadIntegrations = vi
  .fn()
  .mockResolvedValue({ message: "Integrations reloaded", reloaded: 1, enabled: 1 });
const mockResolveConfigWithSources = vi.fn().mockResolvedValue({});

vi.mock("../../integration-host.js", () => ({
  inspectIntegrationRuntime: () => null,
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
const mockTimeline = vi.fn().mockResolvedValue([]);
vi.mock("../../services/health-history.js", () => ({
  getTimeline: (...args: unknown[]) => mockTimeline(...args),
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

vi.mock("../../services/administrative-configuration-writer", () => ({
  withAdministrativeConfigurationRead: async (
    _options: unknown,
    run: (read: unknown) => Promise<unknown>,
  ) => run({}),
}));
vi.mock("../../services/integration-binding-state", () => ({
  capturedBindingState: () => ({
    bindings: { routing: "fixture-service" },
    revision: "a".repeat(64),
    desiredRevision: "a".repeat(64),
  }),
}));
const setBinding = vi.fn();
const removeBinding = vi.fn();
const getRegistry = vi.fn();
vi.mock("../../services/capability-bindings", () => ({
  listBindingsForIntegration: async () => [{ capability: "routing", serviceId: "fixture-service" }],
  setBinding: (...args: unknown[]) => setBinding(...args),
  removeBinding: (...args: unknown[]) => removeBinding(...args),
}));
vi.mock("../../services/service-registry", () => ({ getServiceRegistry: () => getRegistry() }));
const { adminRoute } = await import("../admin");
const { registerCapabilityBindingRoutes } = await import("../admin-capability-bindings");
const health = {
  id: "geocoding-maptiler",
  name: "Fixture",
  category: "integration",
  url: "https://fixture.invalid",
  status: "up" as const,
  responseTime: 5,
};
beforeEach(() => {
  configDb.reset();
  mockApplyWithEvidence.mockReset().mockResolvedValue({
    outcome: {
      outcome: "committed",
      revisionId: `cfg1_${"a".repeat(43)}`,
      enabledServiceIds: [],
      followUp: "complete",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    },
  });
  mockCompensate.mockReset().mockRejectedValue(Error("Must not compensate"));
  mockApply.mockReset().mockResolvedValue({
    revisionId: "revision_1",
    integrationReload: { message: "Integrations reloaded", reloaded: 1, enabled: 1 },
  });
  mockImmediateImport.mockReset().mockImplementation(async ({ body }) => ({
    ok: true,
    imported: body.integrations.length,
    skipped: [],
    message: "Integrations reloaded",
    reloaded: 1,
    enabled: 1,
  }));
  mockRequireAdmin.mockReset().mockResolvedValue(fakeSession);
  mockGetIntegration.mockReset().mockReturnValue(MOCK_INTEGRATION);
  mockGetAllIntegrations.mockReset().mockReturnValue([MOCK_INTEGRATION]);
  mockDbSelect.mockReset().mockImplementation(() => makeSelectChain());
  mockResolveConfigWithSources
    .mockReset()
    .mockResolvedValue({ apiKey: { value: "synthetic-secret", source: "env" } });
  mockReloadIntegrations
    .mockReset()
    .mockResolvedValue({ message: "Integrations reloaded", reloaded: 1, enabled: 1 });
  mockExecuteIntegrationHealthCheck.mockReset().mockResolvedValue([health]);
  mockExecuteAllIntegrationHealthChecks.mockReset().mockResolvedValue([health]);
  mockIsSecretsConfigured.mockReset().mockReturnValue(true);
  getRegistry.mockReset().mockReturnValue({
    get: (id: string) =>
      id === "fixture-service"
        ? { enabled: true, manifest: { id, provides: ["routing"] } }
        : undefined,
  });
  mockImmediateBinding.mockReset().mockResolvedValue({
    operationId: "binding-sdk-fixture",
    integrationId: "geocoding-maptiler",
    desiredRevision: "a".repeat(64),
    database: "retained",
    runtime: "applied",
    runtimeGenerationId: "11111111-1111-4111-8111-111111111111",
  });
  setBinding.mockReset().mockResolvedValue(undefined);
  removeBinding.mockReset().mockResolvedValue(undefined);
  healthCheckSweepLimit.reset();
  vi.stubGlobal("fetch", () => {
    throw Error("Public network denied");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function wire() {
  const app = Fastify();
  const registered = new Map<string, { method: string; path: string }>();
  app.addHook("onRoute", (route) => {
    const id = (route.schema as { operationId?: string })?.operationId;
    if (id && route.method !== "HEAD")
      registered.set(id, { method: String(route.method), path: route.url });
  });
  await app.register(adminRoute, { prefix: "/api" });
  await registerCapabilityBindingRoutes(app);
  await app.ready();
  const transport = administrationSdkFetch(app);
  vi.stubGlobal("fetch", (input: string | Request | URL, init?: RequestInit) => {
    if (new URL(String(input)).origin !== "https://app.test") throw Error("Public network denied");
    return transport(input, init);
  });
  const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
  return { app, registered, client };
}
describe("actual integration producers through generated SDK", () => {
  it("exports and executes exactly all 22 registered operations with full serialized fields", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    for (const id of Object.keys(integrationAdminOperations))
      expect(sdk).toHaveProperty(id, expect.any(Function));
    const { app, registered, client } = await wire();
    const options = { client };
    const id = MOCK_INTEGRATION.id;
    try {
      expect([...registered.keys()].sort()).toEqual(Object.keys(integrationAdminOperations).sort());
      for (const [key, operation] of Object.entries(integrationAdminOperations))
        expect(registered.get(key)).toEqual({ method: operation.method, path: operation.path });
      const detail = await sdk.getAdminIntegration(id, options);
      expect(detail).toMatchObject({
        status: 200,
        data: {
          manifest: MOCK_INTEGRATION.manifest,
          resolvedConfig: { apiKey: { value: "***", source: "env" } },
          credentialStatus: [{ key: "apiKey", source: "env" }],
        },
      });
      expect(JSON.stringify(detail)).not.toContain("synthetic-secret");
      const cases = [
        () => sdk.listAdminIntegrations(options),
        () => sdk.listAdminIntegrationEnvVars(options),
        () => sdk.exportAdminIntegrationConfigs(options),
        () =>
          sdk.importAdminIntegrationConfigs(
            { integrations: [{ integrationId: id, config: { label: "new" } }] },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () => sdk.runAdminIntegrationHealthChecks(undefined, options),
        () => sdk.reloadAdminIntegrations(undefined, options),
        () =>
          sdk.patchAdminIntegrationConfig(
            id,
            { label: "new" },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () =>
          sdk.enableAdminIntegration(
            id,
            { "idempotency-key": crypto.randomUUID() },
            undefined,
            options,
          ),
        () =>
          sdk.disableAdminIntegration(
            id,
            { "idempotency-key": crypto.randomUUID() },
            undefined,
            options,
          ),
        () => sdk.getAdminIntegrationHealth(id, options),
        () => sdk.getAdminIntegrationHealthHistory(id, undefined, options),
        () => sdk.reloadAdminIntegration(id, undefined, options),
        () => sdk.listAdminIntegrationBindings(id, options),
        () =>
          sdk.setAdminIntegrationBinding(
            id,
            "routing",
            { serviceId: "fixture-service", ...expectedBinding },
            bindingHeaders(),
            options,
          ),
        () =>
          sdk.deleteAdminIntegrationBinding(
            id,
            "routing",
            expectedBinding,
            bindingHeaders(),
            options,
          ),
        () => sdk.listAdminCredentials(options),
        () => sdk.getAdminIntegrationCredentials(id, options),
        () => {
          mockGetIntegration.mockReturnValueOnce({
            ...MOCK_INTEGRATION,
            manifest: {
              ...MOCK_INTEGRATION.manifest,
              healthCheck: { type: "http", url: "https://fixture.invalid" },
            },
          });
          return sdk.testAdminIntegrationCredentials(id, { key: "apiKey" }, options);
        },
        () =>
          sdk.setAdminIntegrationCredential(
            id,
            "apiKey",
            { value: "synthetic-credential" },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () =>
          sdk.deleteAdminIntegrationCredential(
            id,
            "apiKey",
            { "idempotency-key": crypto.randomUUID() },
            undefined,
            options,
          ),
        () => sdk.getAdminOverview(options),
      ];
      for (const call of cases)
        expect(await call(), call.toString()).toMatchObject({ status: 200 });
      expect(cases).toHaveLength(21);
      mockGetIntegration.mockReturnValueOnce({
        ...MOCK_INTEGRATION,
        manifest: {
          ...MOCK_INTEGRATION.manifest,
          healthCheck: { type: "http", url: "https://fixture.invalid" },
        },
      });
      expect(await sdk.getAdminIntegrationHealth(id, options)).toMatchObject({
        status: 200,
        data: [health],
      });
    } finally {
      await app.close();
    }
  });
  it.each(["patch", "enable", "disable"] as const)(
    "forwards ordinary %s as a finite candidate overlay without route-local writes",
    async (kind) => {
      const sdk = await import("@openmapx/core/api-admin-sdk"),
        { app, client } = await wire();
      const id = MOCK_INTEGRATION.id;
      try {
        const response =
          kind === "patch"
            ? await sdk.patchAdminIntegrationConfig(
                id,
                { nested: { count: 9 } },
                { "idempotency-key": crypto.randomUUID() },
                { client },
              )
            : kind === "enable"
              ? await sdk.enableAdminIntegration(
                  id,
                  { "idempotency-key": crypto.randomUUID() },
                  undefined,
                  { client },
                )
              : await sdk.disableAdminIntegration(
                  id,
                  { "idempotency-key": crypto.randomUUID() },
                  undefined,
                  { client },
                );
        expect(response).toMatchObject({ status: 200, data: { ok: true } });
        expect(mockApply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: "integrationConfig.apply",
            integrationId: id,
            overlay: {
              purpose: "integration-config",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "integration-config",
                  integrationId: id,
                  set: kind === "patch" ? { nested: { count: 9 } } : { enabled: kind === "enable" },
                  unset: [],
                },
              ],
            },
          }),
        );
        expect(configDb.writes).toBe(0);
        expect(mockReloadIntegrations).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it.each(["patch", "enable", "disable"] as const)(
    "does not perform a route-local inverse after an older ordinary %s producer fails",
    async (kind) => {
      const sdk = await import("@openmapx/core/api-admin-sdk");
      const { app, client } = await wire();
      const id = MOCK_INTEGRATION.id;
      configDb.reset([
        {
          id: "row-a",
          integrationId: id,
          config: { label: "old", enabled: kind === "disable" },
          version: "0",
        },
      ]);
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      mockApply.mockImplementationOnce(async () => {
        reached.resolve();
        await resume.promise;
        throw new TrustedConfigurationApplyError({
          outcome: "not_committed",
          reason: "failed",
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        });
      });
      const ordinary =
        kind === "patch"
          ? sdk.patchAdminIntegrationConfig(
              id,
              { nested: { count: 9 } },
              { "idempotency-key": crypto.randomUUID() },
              { client },
            )
          : kind === "enable"
            ? sdk.enableAdminIntegration(
                id,
                { "idempotency-key": crypto.randomUUID() },
                undefined,
                { client },
              )
            : sdk.disableAdminIntegration(
                id,
                { "idempotency-key": crypto.randomUUID() },
                undefined,
                { client },
              );
      try {
        await reached.promise;
        expect(
          await sdk.importAdminIntegrationConfigs(
            { integrations: [{ integrationId: id, config: { label: "imported", enabled: true } }] },
            { "idempotency-key": crypto.randomUUID() },
            { client },
          ),
        ).toMatchObject({ status: 200 });
        resume.resolve();
        expect(await ordinary).toMatchObject({ status: 500 });
        expect(configDb.rows[0].config).toEqual({ label: "old", enabled: kind === "disable" });
        expect(configDb.writes).toBe(0);
      } finally {
        resume.resolve();
        await ordinary;
        await app.close();
      }
    },
  );
  it("keeps binding body-before-auth, rejects failed writes and never leaks backend errors", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const { app, client } = await wire();
    try {
      mockRequireAdmin.mockRejectedValue(Object.assign(Error("Denied"), { statusCode: 403 }));
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/integrations/fixture/bindings/routing",
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      expect(mockRequireAdmin).not.toHaveBeenCalled();
      expect(
        (
          await sdk.setAdminIntegrationBinding(
            "fixture",
            "routing",
            { serviceId: "fixture-service", ...expectedBinding },
            bindingHeaders(),
            { client },
          )
        ).status,
      ).toBe(403);
      mockRequireAdmin.mockResolvedValue(fakeSession);
      mockImmediateBinding.mockRejectedValueOnce(Error("synthetic-secret"));
      const failed = await sdk.setAdminIntegrationBinding(
        "fixture",
        "routing",
        { serviceId: "fixture-service", ...expectedBinding },
        bindingHeaders(),
        { client },
      );
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
      mockImmediateBinding.mockRejectedValueOnce(Error("synthetic-secret"));
      expect(
        (
          await sdk.deleteAdminIntegrationBinding(
            "fixture",
            "routing",
            expectedBinding,
            bindingHeaders(),
            { client },
          )
        ).status,
      ).toBe(500);
      getRegistry.mockImplementationOnce(() => {
        throw Error("unavailable");
      });
      expect(
        (
          await sdk.setAdminIntegrationBinding(
            "fixture",
            "routing",
            { serviceId: "fixture-service", ...expectedBinding },
            bindingHeaders(),
            { client },
          )
        ).status,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
  it("preserves 400/401/403/404/413/415/429/500/503 and bounded health inputs", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const { app, client } = await wire();
    const id = MOCK_INTEGRATION.id;
    try {
      for (const statusCode of [401, 403]) {
        mockRequireAdmin.mockRejectedValueOnce(Object.assign(Error("Denied"), { statusCode }));
        expect(
          (await sdk.getAdminIntegrationHealthHistory(id, { hours: 24 }, { client })).status,
        ).toBe(statusCode);
      }
      for (const query of ["0", "169", "NaN", "1.2", "Infinity", "-1", "1&hours=2", ""])
        expect(
          (await app.inject(`/api/admin/integrations/${id}/health/history?hours=${query}`))
            .statusCode,
        ).toBe(400);
      mockGetIntegration.mockReturnValueOnce(null);
      expect((await sdk.getAdminIntegration(id, { client })).status).toBe(404);
      expect((await sdk.runAdminIntegrationHealthChecks(undefined, { client })).status).toBe(200);
      const limited = await sdk.runAdminIntegrationHealthChecks(undefined, { client });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      mockIsSecretsConfigured.mockReturnValueOnce(false);
      expect(
        await sdk.setAdminIntegrationCredential(
          id,
          "apiKey",
          { value: "synthetic" },
          { "idempotency-key": crypto.randomUUID() },
          { client },
        ),
      ).toMatchObject({ status: 503, data: { hint: expect.any(String) } });
      mockApply.mockRejectedValueOnce(Error("synthetic-secret"));
      const failed = await sdk.enableAdminIntegration(
        id,
        { "idempotency-key": crypto.randomUUID() },
        undefined,
        { client },
      );
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
      const malformed = await app.inject({
        method: "PUT",
        url: `/api/admin/credentials/${id}/apiKey`,
        headers: { "content-type": "application/json" },
        payload: '{"value":synthetic-secret}',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain("synthetic");

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/integrations/import",
            headers: { "content-type": "application/xml" },
            payload: "<test/>",
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/integrations/import",
            payload: { oversized: "x".repeat(1024 * 1024) },
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/integrations/${id}/enable`,
            headers: { "content-type": "application/json" },
            payload: "null",
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("carries bounded entry/field/rule diagnostics from the actual import producer through the SDK", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const { app, client } = await wire();
    try {
      const response = await sdk.importAdminIntegrationConfigs(
        {
          integrations: [
            {
              integrationId: "geocoding-maptiler",
              config: { label: "synthetic-secret", nested: { count: 0 } },
            },
          ],
        },
        { "idempotency-key": crypto.randomUUID() },
        { client },
      );
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        errors: [
          expect.stringMatching(/entry 1.*geocoding-maptiler.*nested.*(constraint|minimum|range)/i),
        ],
      });
      expect(JSON.stringify(response.data)).not.toContain("synthetic-secret");
      const { integrationErrorMessage } = await import(
        "../../../../web/src/lib/admin/integrationErrors"
      );
      let displayed = "";
      try {
        sdk.unwrapAdminResponse(response);
      } catch (error) {
        displayed = integrationErrorMessage(error, "Import failed");
      }
      expect(displayed).toMatch(/Entry 1.*geocoding-maptiler.*nested.*minimum/);
      expect(configDb.writes).toBe(0);
    } finally {
      await app.close();
    }
  });
  describe.each(["incomplete", "reload"] as const)(
    "retained failure projection after %s",
    (failure) => {
      it.each(["conflict", "unknown", "retained"] as const)(
        "carries retained %s evidence through the registered route, generated SDK and browser formatter",
        async (database) => {
          const sdk = await import("@openmapx/core/api-admin-sdk");
          const { integrationErrorMessage } = await import(
            "../../../../web/src/lib/admin/integrationErrors"
          );
          const { app, client } = await wire();
          const id = MOCK_INTEGRATION.id;
          configDb.reset([
            { id: "row-alpha", integrationId: id, config: { label: "saved-before" }, version: "0" },
          ]);
          const outcome = {
            outcome: "committed" as const,
            revisionId: `cfg1_${"b".repeat(43)}`,
            enabledServiceIds: [],
            followUp: failure === "incomplete" ? ("failed" as const) : ("complete" as const),
            cleanupFailed: false,
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          };
          mockImmediateImport.mockResolvedValueOnce({
            ok: false,
            error: "Integration import failed",
            recovery: "reconciliation_required",
            reason: "previous_applied_not_proven",
            database,
            phase: failure === "incomplete" ? "apply" : "reload",
            runtime: failure === "incomplete" ? "unchanged" : "unknown",
            apply: outcome,
          });
          try {
            const response = await sdk.importAdminIntegrationConfigs(
              { integrations: [{ integrationId: id, config: { label: "imported" } }] },
              { "idempotency-key": crypto.randomUUID() },
              { client },
            );
            expect(response.status).toBe(409);
            expect(response.data).toEqual({
              ok: false,
              error: "Integration import failed",
              recovery: "reconciliation_required",
              reason: "previous_applied_not_proven",
              database,
              phase: failure === "incomplete" ? "apply" : "reload",
              runtime: failure === "incomplete" ? "unchanged" : "unknown",
              apply: outcome,
            });
            let displayed = "";
            try {
              sdk.unwrapAdminResponse(response);
            } catch (error) {
              displayed = integrationErrorMessage(error, "Import failed");
            }
            if (database === "retained")
              expect(displayed).toContain("The imported configuration is saved.");
            else {
              expect(displayed).toContain(
                database === "conflict"
                  ? "newer edits were preserved"
                  : "The saved configuration is uncertain.",
              );
              expect(displayed).not.toContain("The imported configuration is saved.");
            }
            expect(configDb.rows[0].config).toEqual({ label: "saved-before" });
            expect(configDb.writes).toBe(0);
            expect(mockImmediateImport).toHaveBeenCalledTimes(1);
            expect(mockCompensate).not.toHaveBeenCalled();
            expect(mockApplyWithEvidence).not.toHaveBeenCalled();
            expect(mockReloadIntegrations).not.toHaveBeenCalled();
          } finally {
            await app.close();
          }
        },
      );
    },
  );
  it("validates the whole import before writes and carries explicit reconciliation evidence over generated transport", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const { app, client } = await wire();
    try {
      for (const body of [
        null,
        {},
        { integrations: [] },
        {
          integrations: [
            { integrationId: "geocoding-maptiler", config: { label: "valid" } },
            { integrationId: "unknown", config: {} },
          ],
        },
        {
          integrations: [{ integrationId: "geocoding-maptiler", config: { nested: { count: 0 } } }],
        },
      ]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/admin/integrations/import",
              headers: { "content-type": "application/json" },
              payload: JSON.stringify(body),
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(configDb.writes).toBe(0);
      mockImmediateImport.mockResolvedValueOnce({
        ok: false,
        error: "Integration import failed",
        phase: "persistence",
        recovery: "reconciliation_required",
        database: "unknown",
        runtime: "unchanged",
      });
      const failed = await sdk.importAdminIntegrationConfigs(
        { integrations: [{ integrationId: "geocoding-maptiler", config: {} }] },
        { "idempotency-key": crypto.randomUUID() },
        { client },
      );
      expect(failed).toMatchObject({
        status: 409,
        data: {
          ok: false,
          phase: "persistence",
          recovery: "reconciliation_required",
          database: "unknown",
        },
      });
      expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
      const timestamp = "2026-10-20 10:00:00";
      mockTimeline.mockResolvedValueOnce([
        { hour: timestamp, total: 3, healthy: 2, uptimePercent: 67, avgResponseTime: 6 },
      ]);
      expect(
        await sdk.getAdminIntegrationHealthHistory("geocoding-maptiler", undefined, { client }),
      ).toMatchObject({
        status: 200,
        data: {
          hours: 24,
          timeline: [
            {
              hour: "2026-10-20T10:00:00.000Z",
              total: 3,
              healthy: 2,
              uptimePercent: 67,
              avgResponseTime: 6,
            },
          ],
        },
      });
    } finally {
      await app.close();
    }
  });
  it("retains real cookie CSRF and the public rate floor", async () => {
    const app = Fastify();
    const limiter = new RateLimiter({ max: 2, windowMs: 60000 });
    const unexpected = async () => {
      throw Error("wrong tier");
    };
    app.addHook(
      "onRequest",
      makeRateLimitTierHook({
        auth: unexpected,
        tile: unexpected,
        expensive: unexpected,
        status: unexpected,
        public: limiter.preHandler(),
      }),
    );
    app.addHook("preHandler", makeCsrfGuardHook(["https://app.test"]));
    await app.register(adminRoute, { prefix: "/api" });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/integrations/reload",
            remoteAddress: "198.51.100.7",
            headers: { cookie: "session=fake", origin: "https://evil.test" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: "/api/admin/integrations", remoteAddress: "198.51.100.7" }))
          .statusCode,
      ).toBe(200);
      const response = await app.inject({
        url: "/api/admin/integrations",
        remoteAddress: "198.51.100.7",
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toMatch(/^\d+$/);
    } finally {
      limiter.destroy();
      await app.close();
    }
  });
});
