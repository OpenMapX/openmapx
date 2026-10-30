import { createApiClient } from "@openmapx/core";
import {
  artifactTransferAdminOperations,
  platformAdminOperations,
  serviceAdminOperations,
} from "@openmapx/core/api-contracts";
import {
  type OpsOperation,
  type OpsOperationKind,
  type OpsSubmitResult,
  parseOpsJobStatusForKind,
  SERVICE_ACTIONS,
} from "@openmapx/core/ops";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRateLimitTierHook } from "../../server-wiring";
import { TrustedConfigurationApplyError } from "../../services/trusted-config-outcome";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { RateLimiter, serviceActionLimit } from "../../utils/rate-limit";
import { installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";
import {
  serviceDataFixture,
  serviceFixture,
  serviceHardlinksFixture,
  serviceSelectionFixture,
} from "./helpers/service-admin-fixtures";

const { requireAdmin, session, writeAuditLog } = installAdminRouteMocks();
const service = {
  ...serviceFixture(),
  manifest: {
    ...serviceFixture().manifest,
    unfamiliar: { nested: [null, { retained: true }] },
    provides: ["routing", { capability: "geocoding", metadata: { custom: [1, null] } }],
    container: { ...serviceFixture().manifest.container, unfamiliar: { nested: true }, gpu: {} },
    configSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, default: 2 },
        locked: { type: "string", readOnly: true },
        API_KEY: {
          type: "string",
          title: "API key",
          "x-openmapx-secret": true,
          "x-openmapx-setup": { url: "https://example.test/setup" },
        },
      },
      unfamiliar: { preserved: true },
    },
  },
};
const bundle = new Map([
  ["dawarich-app", ["1.15.3", "freikin/dawarich", "1.15.3"]],
  ["dawarich-sidekiq", ["1.15.3", "freikin/dawarich", "1.15.3"]],
  ["dawarich-postgis", ["18-3.6", "ghcr.io/baosystems/postgis", "18-3.6"]],
  ["dawarich-redis", ["7.4", "redis", "7.4-alpine"]],
]);
const getService = vi.fn((id: string) => {
  const item = bundle.get(id);
  if (item)
    return {
      ...service,
      manifest: {
        ...service.manifest,
        id,
        version: item[0],
        container: { image: item[1], tag: item[2] },
      },
    };
  return id === "motis" ? service : undefined;
});
const registry = vi.fn(() => ({ list: () => [service], get: getService }));
vi.mock("../../services/service-registry", () => ({ getServiceRegistry: () => registry() }));
const enqueue = vi.fn().mockResolvedValue("job-accepted");
const cancelJob = vi.fn();
const composeStart = vi.fn();
vi.mock("../../services/job-runner", () => ({
  jobRunner: {
    enqueue: (...args: unknown[]) => enqueue(...args),
    cancel: (...args: unknown[]) => cancelJob(...args),
    startImmediateCompose: (...args: unknown[]) => composeStart(...args),
  },
}));
const apply = vi.fn().mockResolvedValue({ revisionId: "revision_1" });
vi.mock("../../services/trusted-config-operations", () => ({
  applyTrustedConfiguration: (...args: unknown[]) => apply(...args),
  buildConfigurationInput: async () => ({}),
  integrationSchemas: () => new Map(),
}));
let storedConfig: Record<string, unknown> | null = null;
const merge = vi.fn();
const restore = vi.fn().mockResolvedValue(true);
const persist = vi.fn<(...args: unknown[]) => Promise<{ restore(): Promise<boolean> }>>(
  async (...args) => {
    await merge(...args);
    return { restore };
  },
);
const internalFailures: unknown[] = [];
vi.mock("../admin-service-contract", async (actual) => {
  const real = await actual<typeof import("../admin-service-contract")>();
  return {
    registerServiceAdminRoute: ((app, operation, handler, options) =>
      real.registerServiceAdminRoute(
        app,
        operation,
        async (req, reply) => {
          try {
            return await handler(req, reply);
          } catch (error) {
            internalFailures.push(error);
            throw error;
          }
        },
        options,
      )) as typeof real.registerServiceAdminRoute,
  };
});
vi.mock("../../services/service-config-writer", () => ({
  persistServiceConfigPatch: (...args: unknown[]) => persist(...args),
}));
vi.mock("../../services/service-config-resolver", () => ({
  resolveServiceConfigWithSources: async () => ({
    count: { value: 2, source: "default" },
    API_KEY: { value: "synthetic-secret", source: "env" },
  }),
}));
vi.mock("../../services/configuration-ownership-view", async (original) => ({
  ...(await original<typeof import("../../services/configuration-ownership-view")>()),
  inspectServiceConfiguration: async () => ({
    resolved: {
      count: { value: 2, source: "default" },
      API_KEY: { value: "synthetic-secret", source: "env" },
    },
    ownership: {},
  }),
}));
const setSecret = vi.fn();
const deleteSecret = vi.fn();
vi.mock("../../services/service-secrets", () => ({
  listServiceSecrets: async () => [
    { key: "API_KEY", updatedAt: new Date("2026-10-21T00:00:00Z"), updatedBy: null },
  ],
  setServiceSecret: (...args: unknown[]) => setSecret(...args),
  deleteServiceSecret: (...args: unknown[]) => deleteSecret(...args),
}));
vi.mock("../../services/secrets", () => ({ isSecretsConfigured: () => true }));
const dockerAvailable = vi.fn().mockResolvedValue(true);
vi.mock("../../services/admin-ops", () => ({
  INFRA_DIR: "/synthetic/infra",
  isDockerAvailable: () => dockerAvailable(),
  renderAndPersistCompose: vi.fn(async () => ({ revisionId: `cfg1_${"r".repeat(43)}` })),
  applyGenerationHardlinks: async () => serviceHardlinksFixture,
}));
vi.mock("@openmapx/core/server", async (actual) => ({
  ...(await actual<typeof import("@openmapx/core/server")>()),
  repoPaths: () => ({ infraDir: "/synthetic/infra" }),
  services: {
    ...(await actual<typeof import("@openmapx/core/server")>()).services,
    renderConfiguration: () => ({ rendered: { composeYaml: "services:\n  fixture: {}\n" } }),
  },
}));
vi.mock("../../services/desired-selection", () => ({
  readDesiredSelection: async () => ({ roots: [], source: "default" }),
}));
const validateSelection = vi.fn(async (_registry: unknown, roots: string[]) => ({
  normalized: roots,
}));
vi.mock("../../services/admin-cli", () => ({
  assertValidBackupName: vi.fn(),
  validateServiceSelectionForWrite: (...args: Parameters<typeof validateSelection>) =>
    validateSelection(...args),
  getServiceSelectionSummary: async (_registry: unknown, roots = []) => ({
    ...serviceSelectionFixture,
    selectedRoots: roots,
  }),
}));
const status = {
  installed: true,
  selected: true,
  running: false,
  healthy: false,
  publicOrigin: "https://timeline.example.test",
  oauthClient: {
    present: true,
    clientId: "public-id",
    redirectUriMatches: true,
    settingsMatch: true,
    recoveryRequired: false,
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
class ProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const inspect = vi.fn().mockResolvedValue(status);
const provision = vi.fn().mockResolvedValue({ status, audit: { outcome: "success" } });
const rotate = vi.fn().mockResolvedValue({ status, audit: { outcome: "success" } });
vi.mock("../../services/dawarich/provisioning", () => ({
  DAWARICH_APP_SERVICE_ID: "dawarich-app",
  DAWARICH_WORKER_SERVICE_ID: "dawarich-sidekiq",
  DAWARICH_POSTGIS_SERVICE_ID: "dawarich-postgis",
  DAWARICH_REDIS_SERVICE_ID: "dawarich-redis",
  ManagedDawarichProvisioningError: ProvisioningError,
  inspectManagedDawarichProvisioning: () => inspect(),
  provisionManagedDawarich: (...args: unknown[]) => provision(...args),
  rotateManagedDawarichOidcSecret: (...args: unknown[]) => rotate(...args),
}));
const backupInventory = {
  backups: [
    {
      backupId: "nightly",
      createdAt: "2026-10-21T00:00:00Z",
      platformVersion: "1.2.3",
      serviceCount: 2,
      volumeCount: 3,
      totalBytes: 42,
      formatVersion: 2 as const,
      verified: true,
      manifestDigest: "a".repeat(64),
      volumes: [],
    },
  ],
  warningCount: 1,
};
const execute = vi.fn(
  async (
    operation: OpsOperation,
    options: { operationKey?: string; signal?: AbortSignal },
  ): Promise<OpsSubmitResult> => {
    if (operation.kind === "services.inspect")
      return {
        execution: "sync",
        kind: operation.kind,
        value: {
          services: [
            {
              serviceId: "motis",
              state: "running",
              actions: Object.fromEntries(
                SERVICE_ACTIONS.map((action) => [
                  action,
                  { available: false, execution: "direct", reason: "unavailable", workflow: null },
                ]),
              ) as never,
            },
          ],
        },
      };
    if (operation.kind === "stack.status")
      return {
        execution: "sync",
        kind: operation.kind,
        value: { services: [{ serviceId: "motis", state: "running" }] },
      };
    if (operation.kind === "configuration.inspect")
      return {
        execution: "sync",
        kind: operation.kind,
        value: { revisionId: null, integrationConfigDigests: [] },
      };
    if (operation.kind === "data.inspect")
      return { execution: "sync", kind: operation.kind, value: serviceDataFixture };
    if (operation.kind === "backup.list")
      return { execution: "sync", kind: operation.kind, value: backupInventory };
    if (
      (operation.kind !== "stack.start" && operation.kind !== "service.logs.follow") ||
      !options.operationKey
    )
      throw Error("Unexpected typed operation or missing identity");
    return {
      execution: "async",
      operationId: "job1_syntheticFollow00",
      kind: operation.kind,
      operationKey: options.operationKey,
      state: "succeeded",
    };
  },
);
const events = vi.fn().mockResolvedValue({
  version: 1,
  operationId: "job1_syntheticFollow00",
  nextCursor: 1,
  terminal: true,
  truncated: false,
  events: [{ cursor: 1, type: "log", stream: "stdout", message: "hello €" }],
});
const opsCancel = vi.fn();
const ops = {
  execute,
  events,
  cancel: opsCancel,
  status: vi.fn(async (kind: OpsOperationKind, operationId: string) =>
    parseOpsJobStatusForKind(kind, {
      version: 1,
      kind,
      operationId,
      resourceId: "motis",
      submittedAt: "2026-10-21T00:00:00Z",
      updatedAt: "2026-10-21T00:00:00Z",
      state: "succeeded",
      operationKey: execute.mock.calls.at(-1)?.[1].operationKey,
      result: kind === "service.logs.follow" ? { lines: 1, truncated: false } : { changed: true },
    }),
  ),
  lookup: vi.fn().mockResolvedValue(null),
};
vi.mock("../../services/ops-client", async (actual) => ({
  ...(await actual<typeof import("../../services/ops-client")>()),
  createApiOpsClient: () => ops,
}));

const sdk = await import("@openmapx/core/api-admin-sdk");
const executeDefault = execute.getMockImplementation()!;
const { adminServicesRoute } = await import("../admin-services");
const { adminOperationsRoute } = await import("../admin-operations");
const { adminDawarichRoute } = await import("../admin-dawarich");
const { registerAdminComposeRoutes } = await import("../admin-compose");
beforeEach(() => {
  vi.clearAllMocks();
  apply
    .mockReset()
    .mockResolvedValue({ revisionId: `cfg1_${"a".repeat(43)}`, jobId: "job-accepted" });
  execute.mockReset().mockImplementation(executeDefault);
  composeStart
    .mockReset()
    .mockResolvedValue({ ok: true, stdout: "", hardlinks: serviceHardlinksFixture });
  dockerAvailable.mockReset().mockResolvedValue(true);
  internalFailures.length = 0;
  restore.mockReset().mockResolvedValue(true);
  persist.mockReset().mockImplementation(async (...args: unknown[]) => {
    await merge(...args);
    return { restore };
  });
  serviceActionLimit.reset();
  registry.mockReset().mockImplementation(() => ({ list: () => [service], get: getService }));
  requireAdmin.mockResolvedValue(session);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
async function wire(max = 1000) {
  const app = Fastify({ bodyLimit: 8192 });

  const limiter = new RateLimiter({ max, windowMs: 60000 });
  const unexpected = async () => {
    throw Error("Wrong tier");
  };
  app.addHook("onRequest", makeCsrfGuardHook(["https://app.test"]));
  app.addHook(
    "onRequest",
    makeRateLimitTierHook({
      public: limiter.preHandler(),
      auth: unexpected,
      tile: unexpected,
      expensive: unexpected,
      status: unexpected,
    }),
  );
  const registered = new Map<string, string>();
  app.addHook("onRoute", (route) => {
    if (route.method !== "HEAD" && route.schema?.operationId)
      registered.set(route.schema.operationId, route.url);
  });
  for (const route of [
    adminServicesRoute,
    adminOperationsRoute,
    adminDawarichRoute,
    registerAdminComposeRoutes,
  ])
    await app.register(route, { prefix: "/api" });
  await app.ready();
  const transport = administrationSdkFetch(app, { remoteAddress: "198.51.100.8" });
  vi.stubGlobal("fetch", transport);
  const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
  return {
    app,
    registered,
    options: { client, timeoutMs: 30000 },
    close: async () => {
      limiter.destroy();
      await app.close();
    },
  };
}

describe("actual service producers through final exported SDK", () => {
  it("keeps configured deployment identity while the agent is unavailable", async () => {
    vi.stubEnv("OPS_AGENT_URL", "http://ops-agent:3000");
    vi.stubEnv("OPS_AGENT_TOKEN_FILE", "/unavailable/token");
    dockerAvailable.mockResolvedValue(false);
    const { options, close } = await wire();
    try {
      expect(await sdk.getAdminDeployment(options)).toMatchObject({
        status: 200,
        data: { selfHosted: true, dockerAvailable: false, hostControlConfigured: true },
      });
    } finally {
      await close();
      vi.unstubAllEnvs();
    }
  });

  it.each([null, { count: 1 }])(
    "forwards overlapping intents without route-local desired writes or inverse compensation (prior %j)",
    async (prior) => {
      storedConfig = prior;
      let version = 0;
      merge.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
        storedConfig = { ...storedConfig, ...updates };
        version++;
      });
      persist.mockImplementation(async (...args: unknown[]) => {
        const previous = structuredClone(storedConfig);
        await merge(...args);
        const owned = version;
        return {
          restore: async () => {
            if (version !== owned) return false;
            storedConfig = previous;
            version++;
            return true;
          },
        };
      });
      const resume = Promise.withResolvers<void>();
      apply.mockImplementationOnce(async () => {
        await resume.promise;
        throw new TrustedConfigurationApplyError({
          outcome: "not_committed",
          reason: "failed",
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        });
      });
      const { options, close } = await wire();
      const older = sdk.updateAdminServiceConfig(
        "motis",
        { config: { count: 3 } },
        { "idempotency-key": crypto.randomUUID() },
        options,
      );
      try {
        await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(
          (
            await sdk.updateAdminServiceConfig(
              "motis",
              { config: { count: 4 } },
              { "idempotency-key": crypto.randomUUID() },
              options,
            )
          ).status,
        ).toBe(200);
        resume.resolve();
        expect((await older).status).toBe(500);
        expect(storedConfig).toEqual(prior);
        expect(persist).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
        expect(apply).toHaveBeenLastCalledWith(
          expect.objectContaining({
            overlay: {
              purpose: "service-config",
              coordinatorMode: "ensure-running",
              changes: [
                { kind: "service-config", serviceId: "motis", set: { count: 4 }, unset: [] },
              ],
            },
          }),
        );
      } finally {
        resume.resolve();
        await older;
        await close();
        merge.mockReset();
      }
    },
  );

  it.each(["not_committed", "committed", "unknown"] as const)(
    "keeps %s apply failure through serialized SDK without an unproven inverse",
    async (outcome) => {
      const failure = new TrustedConfigurationApplyError({
        ...(outcome === "unknown"
          ? { outcome, reason: "transport_or_result" as const }
          : outcome === "committed"
            ? {
                outcome,
                revisionId: `cfg1_${"a".repeat(43)}`,
                enabledServiceIds: [],
                followUp: "failed" as const,
                cleanupFailed: false,
              }
            : { outcome, reason: "failed" as const, cleanupFailed: false }),
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      });
      apply.mockRejectedValueOnce(failure);
      restore.mockResolvedValueOnce(false);
      const { options, close } = await wire();
      try {
        const response = await sdk.updateAdminServiceConfig(
          "motis",
          { config: { count: 3 } },
          { "idempotency-key": crypto.randomUUID() },
          options,
        );
        expect(response.status).toBe(500);
        expect(response.data).toEqual({ error: "Service administration failed" });
        expect(persist).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
        expect(internalFailures).toEqual([failure]);
        expect(writeAuditLog).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );

  it("retains the original producer failure internally without a route-local inverse", async () => {
    const failure = new TrustedConfigurationApplyError({
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    });
    failure.message = "synthetic-secret-apply";
    const inverseFailure = new Error("synthetic-secret-inverse");
    apply.mockRejectedValueOnce(failure);
    restore.mockRejectedValueOnce(inverseFailure);
    const { options, close } = await wire();
    try {
      const response = await sdk.updateAdminServiceConfig(
        "motis",
        { config: { count: 3 } },
        { "idempotency-key": crypto.randomUUID() },
        options,
      );
      expect(response.status).toBe(500);
      expect(response.data).toEqual({ error: "Service administration failed" });
      expect(internalFailures[0]).toBe(failure);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("exports every registered service-family method", async () => {
    const { registered, close } = await wire();
    try {
      const dedicated = new Set([
        ...Object.keys(platformAdminOperations),
        ...Object.keys(artifactTransferAdminOperations),
      ]);
      expect([...registered.keys()].sort()).toEqual(
        Object.keys(serviceAdminOperations)
          .filter((id) => !dedicated.has(id))
          .sort(),
      );
      for (const [id, contract] of Object.entries(serviceAdminOperations)) {
        expect(sdk).toHaveProperty(id, expect.any(Function));
        if (!dedicated.has(id)) expect(registered.get(id)).toBe(contract.path);
      }
    } finally {
      await close();
    }
  });
  it("forwards only bounded OSM pagination through the actual route and generated SDK", async () => {
    const { options, close } = await wire();
    try {
      const result = await sdk.getAdminServiceData({ osmLimit: 2, osmOffset: 50 }, options);
      expect(result.status).toBe(200);
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "data.inspect", osmLimit: 2, osmOffset: 50 }),
        expect.anything(),
      );
      const before = execute.mock.calls.length;
      expect((await sdk.getAdminServiceData({ osmLimit: 501 }, options)).status).toBe(400);
      expect(execute.mock.calls.length).toBe(before);
    } finally {
      await close();
    }
  });

  it("preserves complete manifests, omitted defaults, configuration, timestamps and inventory", async () => {
    const { options, close } = await wire();
    try {
      const detail = await sdk.getAdminService("motis", options);
      expect(detail).toMatchObject({ status: 200, data: { ...service, status: "running" } });
      if (detail.status === 200) expect(detail.data.manifest).toEqual(service.manifest);
      const config = await sdk.getAdminServiceConfig("motis", options);
      expect(config).toMatchObject({
        status: 200,
        data: {
          schema: service.manifest.configSchema,
          resolvedConfig: { API_KEY: { value: "***", source: "env" } },
        },
      });
      expect(JSON.stringify(config)).not.toContain("synthetic-secret");
      expect(await sdk.getAdminServiceCredentials("motis", options)).toMatchObject({
        status: 200,
        data: {
          credentials: [
            {
              key: "API_KEY",
              source: "env",
              updatedAt: "2026-10-21T00:00:00.000Z",
              updatedBy: null,
              setup: { url: "https://example.test/setup" },
            },
          ],
        },
      });
      expect(await sdk.getAdminServiceData(undefined, options)).toMatchObject({
        status: 200,
        data: { ...serviceDataFixture, fetchedAt: expect.any(String) },
      });
      expect(await sdk.listAdminServiceBackups(options)).toMatchObject({
        status: 200,
        data: {
          root: "ops-agent-managed",
          warnings: ["1 backup entries could not be validated"],
          backups: [
            {
              name: "nightly",
              serviceCount: 2,
              volumeCount: 3,
              totalBytes: 42,
              openmapxVersion: "1.2.3",
            },
          ],
        },
      });
      const check = await sdk.checkAdminServices(undefined, options);
      expect(check).toMatchObject({
        status: 200,
        data: { statuses: [{ service: "motis", state: "running" }], checkedAt: expect.any(String) },
      });
      expect(await sdk.getAdminComposePreview(options)).toMatchObject({
        status: 200,
        data: "services:\n  fixture: {}\n",
      });
    } finally {
      await close();
    }
  });
  it("executes every remaining synchronous and accepted operation once without retry or job cancellation", async () => {
    const { options, close } = await wire();
    const key = { "idempotency-key": "sdk-synthetic-intent-001" };
    try {
      const calls = [
        () => sdk.listAdminServices(options),
        () => sdk.getAdminDeployment(options),
        () => sdk.getAdminServiceSelection(options),
        () =>
          sdk.setAdminServiceSelection(
            { selectedRoots: [] },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () =>
          sdk.updateAdminServiceConfig(
            "motis",
            { config: { count: 3 } },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () =>
          sdk.setAdminServiceCredential(
            "motis",
            "API_KEY",
            { value: " synthetic " },
            { "idempotency-key": crypto.randomUUID() },
            options,
          ),
        () =>
          sdk.deleteAdminServiceCredential(
            "motis",
            "API_KEY",
            { "idempotency-key": crypto.randomUUID() },
            undefined,
            options,
          ),
        () => sdk.runAdminServiceAction("motis", { action: "restart" }, options),
        () => sdk.runAdminServicesBulkAction({ action: "build", all: true }, options),
        () => sdk.createAdminServiceBackup(undefined, options),
        () =>
          sdk.restoreAdminServiceBackup("nightly", { serviceIds: [], stopRunning: true }, options),
        () => sdk.deleteAdminServiceBackup("nightly", undefined, options),
        () => sdk.startAdminCompose(key, undefined, options),
        () => sdk.listAdminOperations(options),
        () => sdk.previewAdminOperation("download-fonts", null, options),
        () => sdk.runAdminOperation("download-fonts", undefined, options),
        () => sdk.getAdminSharedMobility(options),
        () => sdk.rollbackAdminSharedMobility("bike", { enabled: false }, options),
        () => sdk.getAdminDawarich(options),
      ];
      for (const [index, call] of calls.entries())
        expect((await call()).status, `call ${index}`).toBe(200);
      serviceActionLimit.reset();
      expect((await sdk.provisionAdminDawarich(undefined, options)).status).toBe(200);
      serviceActionLimit.reset();
      expect(
        (
          await sdk.rotateAdminDawarichOidcSecret(
            { confirmation: "ROTATE DAWARICH OIDC SECRET" },
            options,
          )
        ).status,
      ).toBe(200);
      expect(await sdk.stopAdminCompose(undefined, options)).toMatchObject({
        status: 503,
        data: { ok: false, error: expect.stringContaining("host shutdown") },
      });
      const chunks: string[] = [];
      expect(
        await sdk.streamAdminServiceLogs(
          "motis",
          key,
          { lines: "3.9" },
          {
            ...options,
            onTextChunk: (chunk) => {
              chunks.push(chunk);
            },
          },
        ),
      ).toMatchObject({ status: 200, data: undefined });
      expect(chunks.join("")).toBe("hello €\n");
      expect(setSecret).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "vault.apply",
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "ensure-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "motis",
                key: "API_KEY",
                action: "set",
                value: " synthetic ",
              },
            ],
          },
        }),
      );
      expect(enqueue).toHaveBeenCalledTimes(6);
      expect(cancelJob).not.toHaveBeenCalled();
      expect(opsCancel).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it("preserves real CSRF, parser/auth and rate floor precedence", async () => {
    const { app, close } = await wire(2);
    try {
      const input = {
        method: "PUT" as const,
        url: "/api/admin/services/selection",
        remoteAddress: "198.51.100.8",
        payload: {},
      };
      expect(
        (
          await app.inject({
            ...input,
            headers: { cookie: "session=synthetic", origin: "https://evil.test" },
          })
        ).statusCode,
      ).toBe(403);
      expect(requireAdmin).not.toHaveBeenCalled();
      requireAdmin.mockRejectedValueOnce(Object.assign(Error("Denied"), { statusCode: 401 }));
      expect((await app.inject(input)).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            ...input,
            payload: "{",
            headers: { "content-type": "application/json" },
          })
        ).statusCode,
      ).toBe(400);
      const limited = await app.inject(input);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
      expect(limited.json()).toMatchObject({
        error: "Too many requests",
        retryAfter: expect.any(Number),
      });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it("retains action limiter, managed credential, bundle and unknown-ID-first gates", async () => {
    const { app, options, close } = await wire();
    try {
      expect((await sdk.runAdminServiceAction("motis", { action: "start" }, options)).status).toBe(
        200,
      );
      const limited = await app.inject({
        method: "POST",
        url: "/api/admin/services/motis/action",
        remoteAddress: "198.51.100.8",
        payload: { action: 9 },
      });
      expect(limited.statusCode).toBe(429);
      expect(requireAdmin).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/admin/services/dawarich-app/credentials/OIDC_CLIENT_SECRET",
            payload: { value: 9 },
          })
        ).statusCode,
      ).toBe(409);
      getService.mockReturnValueOnce(undefined);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/dawarich/provision",
            payload: { publicHost: 9 },
          })
        ).statusCode,
      ).toBe(409);
      const unknown = await app.inject({
        method: "POST",
        url: "/api/admin/operations/missing/run",
        payload: [1],
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ ok: false, error: "Unknown operation" });
    } finally {
      await close();
    }
  });
});

it("rejects malformed mutation envelopes and members before persistence or host effects", async () => {
  const { app, close } = await wire();
  try {
    for (const payload of [
      undefined,
      null,
      {},
      { selectedRoots: null },
      { selectedRoots: "motis" },
      { selectedRoots: ["motis", 3] },
      { selectedRoots: [" "] },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/admin/services/selection",
            payload: payload === null ? "null" : payload,
            headers: payload === null ? { "content-type": "application/json" } : {},
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const payload of [
      { serviceIds: "motis" },
      { serviceIds: ["motis", 4] },
      { serviceIds: [""] },
      { stopRunning: "yes" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/services/backups/nightly/restore",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    for (const payload of [
      { action: "restart", serviceIds: ["motis", 4] },
      { action: "build", all: "yes" },
      { action: "start", serviceIds: ["motis"], all: true },
    ])
      expect(
        (await app.inject({ method: "POST", url: "/api/admin/services/bulk-action", payload }))
          .statusCode,
      ).toBe(400);
    for (const payload of [{ value: 7 }, { value: " " }, { value: "synthetic", extra: true }])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/admin/services/motis/credentials/API_KEY",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(validateSelection).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("retains structured domain failures and retained credential jobs through SDK validation", async () => {
  const { options, close } = await wire();
  try {
    expect(
      await sdk.updateAdminServiceConfig(
        "motis",
        { config: { count: 0 } },
        { "idempotency-key": crypto.randomUUID() },
        options,
      ),
    ).toMatchObject({ status: 400, data: { errors: [expect.any(String)] } });
    expect(merge).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(
      await sdk.updateAdminServiceConfig(
        "motis",
        { config: { locked: "changed" } },
        { "idempotency-key": crypto.randomUUID() },
        options,
      ),
    ).toMatchObject({ status: 400, data: { errors: [expect.any(String)] } });
    expect(merge).not.toHaveBeenCalled();
    expect(
      await sdk.previewAdminOperation("download-osm", { region: "../bad" }, options),
    ).toMatchObject({
      status: 400,
      data: {
        ok: false,
        error: expect.any(String),
        issues: expect.arrayContaining([{ path: expect.any(String), message: expect.any(String) }]),
      },
    });
    expect(
      await sdk.setAdminServiceCredential(
        "motis",
        "API_KEY",
        { value: "synthetic" },
        { "idempotency-key": crypto.randomUUID() },
        options,
      ),
    ).toMatchObject({ status: 200, data: { ok: true, jobId: "job-accepted" } });
    expect(
      await sdk.setAdminServiceCredential(
        "dawarich-app",
        "OIDC_CLIENT_SECRET",
        { value: "synthetic" },
        { "idempotency-key": crypto.randomUUID() },
        options,
      ),
    ).toMatchObject({
      status: 409,
      data: { code: "DAWARICH_CREDENTIAL_MANAGED", error: expect.any(String) },
    });
    execute.mockRejectedValueOnce(Error("synthetic-secret must be redacted"));
    const failed = await sdk.getAdminServiceData(undefined, options);
    expect(failed).toMatchObject({ status: 500, data: { error: "Service administration failed" } });
    expect(() => sdk.unwrapAdminResponse(failed)).toThrow("API request failed with status 500");
    expect(JSON.stringify(failed)).not.toContain("synthetic-secret");
    execute.mockImplementationOnce(async () => {
      throw Error("agent unavailable");
    });
    expect(await sdk.listAdminServices(options)).toMatchObject({
      status: 200,
      data: {
        acquisition: { state: "unavailable", reason: "ops_unavailable" },
        summary: { running: 0, stopped: 0, unknown: 1, total: 1 },
        services: [
          {
            status: "unknown",
            actions: {
              start: { available: false, reason: "unavailable" },
              logs: { available: false, reason: "unavailable" },
            },
          },
        ],
      },
    });
    expect(cancelJob).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await close();
  }
});

it.each([
  ["DAWARICH_INVALID_PUBLIC_HOST", 422],
  ["DAWARICH_OAUTH_CLIENT_CONFLICT", 409],
  ["DAWARICH_DATABASE_SECRET_CONFLICT", 409],
  ["DAWARICH_RAILS_SECRET_CONFLICT", 409],
  ["DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED", 503],
  ["DAWARICH_PROVISIONING_FAILED", 503],
] as const)("retains Dawarich %s at HTTP %i", async (code, expected) => {
  const { options, close } = await wire();
  try {
    for (const [fake, call] of [
      [inspect, () => sdk.getAdminDawarich(options)],
      [provision, () => sdk.provisionAdminDawarich(undefined, options)],
      [
        rotate,
        () =>
          sdk.rotateAdminDawarichOidcSecret(
            { confirmation: "ROTATE DAWARICH OIDC SECRET" },
            options,
          ),
      ],
    ] as const) {
      serviceActionLimit.reset();
      fake.mockRejectedValueOnce(new ProvisioningError(code));
      expect(await call()).toMatchObject({ status: expected, data: { code } });
    }
  } finally {
    await close();
  }
});

// Keep native loopback acquisition outside the inject-backed SDK transport.
const loopbackFetch = globalThis.fetch;
it("serves actual raw log Content-Type and complete streamed bytes over loopback", async () => {
  const { app, close } = await wire();
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubGlobal("fetch", loopbackFetch);
    const client = createApiClient({ baseUrl });
    const chunks: string[] = [];
    const result = await sdk.streamAdminServiceLogs(
      "motis",
      { "idempotency-key": "raw-synthetic-intent-001" },
      { lines: "3.9" },
      {
        client,
        timeoutMs: 3000,
        onTextChunk: (chunk) => {
          chunks.push(chunk);
        },
      },
    );
    expect(result.status).toBe(200);
    expect(result.data).toBeUndefined();
    expect(result.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(chunks.join("")).toBe("hello €\n");
    expect(execute).toHaveBeenCalledWith(
      { kind: "service.logs.follow", serviceId: "motis", tail: 3, maxDurationSeconds: 900 },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        operationKey: expect.stringMatching(/^opk1_/),
      }),
    );
  } finally {
    await close();
  }
});

it("does not submit log observation when disconnect precedes ops submission", async () => {
  const { app, close } = await wire();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  writeAuditLog.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const rawClosed = Promise.withResolvers<void>();
    app.server.once("request", (_request, response) =>
      response.once("close", () => rawClosed.resolve()),
    );
    const pending = loopbackFetch(`${baseUrl}/api/admin/services/motis/logs`, {
      headers: { "idempotency-key": "raw-synthetic-intent-001" },
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await rawClosed.promise;
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(opsCancel).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await close();
  }
});

it("cancels only the admitted log observation after disconnect during submission", async () => {
  const { app, close } = await wire();
  const entered = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  execute.mockImplementationOnce(async (operation, options) => {
    entered.resolve();
    await admitted.promise;
    return {
      execution: "async",
      operationId: "job1_syntheticFollow00",
      kind: operation.kind,
      operationKey: options.operationKey ?? "opk1_synthetic",
      state: "running",
    };
  });
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const rawClosed = Promise.withResolvers<void>();
    app.server.once("request", (_request, response) =>
      response.once("close", () => rawClosed.resolve()),
    );
    const pending = loopbackFetch(`${baseUrl}/api/admin/services/motis/logs`, {
      headers: { "idempotency-key": "raw-synthetic-intent-001" },
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await rawClosed.promise;
    admitted.resolve();
    await vi.waitFor(() =>
      expect(opsCancel).toHaveBeenCalledWith("job1_syntheticFollow00", expect.anything()),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
  } finally {
    admitted.resolve();
    await close();
  }
});

it("cleans up and cancels active log observation after streaming disconnect", async () => {
  const { app, close } = await wire();
  events.mockResolvedValueOnce({
    version: 1,
    operationId: "job1_syntheticFollow00",
    nextCursor: 1,
    terminal: false,
    truncated: false,
    events: [{ cursor: 1, type: "log", stream: "stdout", message: "first chunk" }],
  });
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await loopbackFetch(`${baseUrl}/api/admin/services/motis/logs`, {
      headers: { "idempotency-key": "raw-synthetic-intent-001" },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first chunk\n");
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await vi.waitFor(() => expect(opsCancel).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(cancelJob).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("preserves Compose idempotency failure before invalid optional body", async () => {
  const { app, close } = await wire();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/compose/up",
      payload: { extra: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "Idempotency-Key must be a single 16-128 character caller-retained identifier",
    });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("retains registry-first selection failure and redacts pre-validation domain exceptions", async () => {
  const { app, close } = await wire();
  try {
    registry.mockImplementationOnce(() => {
      throw Error("synthetic-secret");
    });
    const unavailable = await app.inject({
      method: "PUT",
      url: "/api/admin/services/selection",
      payload: {},
    });
    expect(unavailable.statusCode).toBe(503);
    registry.mockImplementationOnce(() => {
      throw Error("synthetic-secret");
    });
    const failed = await app.inject({
      method: "POST",
      url: "/api/admin/services/motis/config",
      payload: {},
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "Service administration failed" });
    expect(failed.body).not.toContain("synthetic-secret");
  } finally {
    await close();
  }
});

it("keeps log pre-hijack JSON statuses/media, required single headers and bounded range policy", async () => {
  const { app, options, close } = await wire();
  const key = { "idempotency-key": "log-synthetic-intent-001" };
  try {
    const missing = await app.inject({ url: "/api/admin/services/motis/logs" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: "Idempotency-Key must be a single 16-128 character caller-retained identifier",
    });
    expect(missing.headers["content-type"]).toContain("application/json");
    expect(
      (
        await app.inject({
          url: "/api/admin/services/motis/logs",
          headers: { "idempotency-key": [key["idempotency-key"], key["idempotency-key"]] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      await sdk.streamAdminServiceLogs("unknown", key, undefined, {
        ...options,
        onTextChunk: () => {},
      }),
    ).toMatchObject({ status: 404, data: { error: expect.any(String) } });
    getService.mockReturnValueOnce({ ...service, enabled: false });
    expect(
      await sdk.streamAdminServiceLogs("motis", key, undefined, {
        ...options,
        onTextChunk: () => {},
      }),
    ).toMatchObject({ status: 200 });
    registry.mockImplementationOnce(() => {
      throw Error("unavailable");
    });
    expect(
      await sdk.streamAdminServiceLogs("motis", key, undefined, {
        ...options,
        onTextChunk: () => {},
      }),
    ).toMatchObject({ status: 503, data: { error: "Service registry not available" } });
    expect(execute).toHaveBeenCalledTimes(1);
    for (const [lines, tail] of [
      ["", 1],
      ["-2", 1],
      ["3.9", 3],
      ["99999", 1000],
      ["Infinity", 200],
      ["garbage", 200],
    ] as const) {
      await sdk.streamAdminServiceLogs(
        "motis",
        key,
        { lines },
        { ...options, onTextChunk: () => {} },
      );
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "service.logs.follow", tail }),
        expect.anything(),
      );
    }
    const repeated = await app.inject({
      url: "/api/admin/services/motis/logs?lines=2&lines=3",
      headers: key,
    });
    expect(repeated.statusCode).toBe(400);
  } finally {
    await close();
  }
});

it("returns complete Compose HTTP200 failure and does not retry the host action", async () => {
  const { options, close } = await wire();
  try {
    composeStart.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      hardlinks: serviceHardlinksFixture,
    });
    expect(
      await sdk.startAdminCompose(
        { "idempotency-key": "compose-synthetic-intent-002" },
        undefined,
        options,
      ),
    ).toMatchObject({
      status: 200,
      data: { ok: false, stdout: "", hardlinks: serviceHardlinksFixture },
    });
    expect(composeStart).toHaveBeenCalledTimes(1);
    expect(opsCancel).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("leaves accepted mutation jobs running after the HTTP observer disconnects", async () => {
  const { app, close } = await wire();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  writeAuditLog.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const pending = loopbackFetch(`${baseUrl}/api/admin/services/motis/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(cancelJob).not.toHaveBeenCalled();
    expect(opsCancel).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await close();
  }
});

it("retains env-owned selection failures and explicit trimmed/deduplicated intent", async () => {
  const { app, options, close } = await wire();
  try {
    validateSelection.mockRejectedValueOnce(
      Error("OPENMAPX_SERVICES is set; unset it before editing selection"),
    );
    expect(
      await sdk.setAdminServiceSelection(
        { selectedRoots: [] },
        { "idempotency-key": crypto.randomUUID() },
        options,
      ),
    ).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining("OPENMAPX_SERVICES") },
    });
    expect(apply).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/services/selection",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: { selectedRoots: [" motis ", "motis"] },
    });
    expect(response.statusCode).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "serviceSelection.apply", selectedRoots: ["motis"] }),
    );
  } finally {
    await close();
  }
});

it("keeps parser 413/415 and forbidden malformed JSON envelopes serialized before domain effects", async () => {
  const { app, close } = await wire();
  try {
    const headers = { "content-type": "application/json" };
    const oversized = await app.inject({
      method: "POST",
      url: "/api/admin/services/backups",
      headers,
      payload: JSON.stringify({ name: "x".repeat(9000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ statusCode: 413, message: expect.any(String) });
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/admin/services/backups",
      headers: { "content-type": "application/octet-stream" },
      payload: "data",
    });
    expect(unsupported.statusCode).toBe(415);
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/services/backups",
      headers: { ...headers, cookie: "session=synthetic", origin: "https://evil.test" },
      payload: "{",
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "Forbidden" });
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it("retains public corrupt backup metadata, admission failures and intentional restore-all bodies", async () => {
  const { options, close } = await wire();
  const corrupt = {
    backupId: "broken",
    createdAt: "2026-10-21T00:00:00Z",
    serviceCount: 0,
    volumeCount: 0,
    totalBytes: 0,
    corrupt: true,
    corruptReason: "invalid_manifest" as const,
  };
  try {
    execute.mockResolvedValueOnce({
      execution: "sync",
      kind: "backup.list",
      value: { backups: [corrupt], warningCount: 1 },
    });
    expect(await sdk.listAdminServiceBackups(options)).toMatchObject({
      status: 200,
      data: {
        backups: [
          {
            name: "broken",
            createdAt: corrupt.createdAt,
            serviceCount: 0,
            volumeCount: 0,
            totalBytes: 0,
            corrupt: true,
            corruptReason: "invalid_manifest",
          },
        ],
      },
    });
    execute.mockResolvedValueOnce({
      execution: "sync",
      kind: "backup.list",
      value: { backups: [corrupt], warningCount: 1 },
    });
    expect(await sdk.restoreAdminServiceBackup("broken", undefined, options)).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining("invalid_manifest") },
    });
    expect(await sdk.restoreAdminServiceBackup("missing", undefined, options)).toMatchObject({
      status: 404,
      data: { error: "Backup not found: missing" },
    });
    expect(await sdk.deleteAdminServiceBackup("missing", undefined, options)).toMatchObject({
      status: 404,
      data: { error: "Backup not found: missing" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await sdk.restoreAdminServiceBackup("nightly", undefined, options)).status).toBe(200);
    expect(
      (await sdk.restoreAdminServiceBackup("nightly", { serviceIds: [] }, options)).status,
    ).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [, payload] of enqueue.mock.calls)
      expect(payload).toEqual({
        operation: "restore",
        name: "nightly",
        serviceIds: [],
        stopRunning: false,
      });
  } finally {
    await close();
  }
});
