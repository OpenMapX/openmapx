import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { dataConfigurationFencePrepareRequestSchema } from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  feedState,
  jobStages,
  jobs,
  offlinePackageArtifactReferences,
  offlinePackageJobOwners,
  offlinePackageJobs,
} from "@openmapx/db-schema";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as apiSchema from "../../../../../apps/api/src/db/schema";
import type { JobContext } from "../../../../../apps/api/src/services/job-runner";
import { createConfigurationPostgresFixture } from "../../../../../apps/api/src/test/configuration-postgres-fixture";
import { ownedDataManager } from "../../../../../apps/ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../../apps/ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../../apps/ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../../apps/ops-agent/src/server";
import { releaseProvenance } from "../../../../../packages/core/src/services/__fixtures__/release-provenance";

/** What the agent records after data-manager's prepare reply; data-manager never writes the store. */
async function settledByAgent(
  lease: control.TargetLeaseAuthority,
  child: import("@openmapx/core/ops").ExecutionRef,
  receipt: unknown,
) {
  await control.settleIssuedLeaseChild(lease, child, {
    outcome: "committed",
    publication: "committed",
    terminalReceiptDigest: control.controlDigest({ kind: "data-configuration-fence", receipt }),
  });
}

// Keep real filesystem checks and writes; expose only the publication boundary
// so an acknowledged rename can lose its reply in the recovery tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const apiState = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createConfigurationPostgresFixture>>,
}));
// Only the API database connection boundary changes; its real producer,
// transactions, parent attestation and agent HTTP admission remain installed.
vi.mock("../../../../../apps/api/src/db", () => ({
  get db() {
    return apiState.fixture.db;
  },
  get sql() {
    return apiState.fixture.sql;
  },
}));

import { registerApi } from "../../../../../services/data-manager/src/api.js";
import { registerAuth } from "../../../../../services/data-manager/src/auth.js";
import { DATA_MANAGER_CONTROL_SERVICE_IDS } from "../../../../../services/data-manager/src/control-targets.js";
import { setupCron } from "../../../../../services/data-manager/src/cron.js";
import { installDataMutationAdmission } from "../../../../../services/data-manager/src/jobs/execution/admission.js";
import { createDataConfigurationMaintenance } from "../../../../../services/data-manager/src/jobs/execution/configuration-maintenance.js";
import { createDataExecutionDispatcher } from "../../../../../services/data-manager/src/jobs/execution/dispatch.js";
import { startLegacyDataMutation } from "../../../../../services/data-manager/src/jobs/execution/legacy-mutation.js";
import { createDataExecutionReceiver } from "../../../../../services/data-manager/src/jobs/execution/receiver.js";
import { createDataExecutionRuntime } from "../../../../../services/data-manager/src/jobs/execution/runtime.js";
import { createPostgresDataExecutionStore } from "../../../../../services/data-manager/src/jobs/execution/store.js";
import { createJobRow } from "../../../../../services/data-manager/src/jobs/persistence.js";
import { resolveOperationsProfile } from "../../../../../services/data-manager/src/jobs/transitous/operations-profile.js";
import { createSingleFlightController } from "../../../../../services/data-manager/src/jobs/transitous/single-flight.js";
import { PostgresOfflinePackageAccountingStore } from "../../../../../services/data-manager/src/offline-packages/postgres-accounting.js";
import type { OfflinePackageJobRecord } from "../../../../../services/data-manager/src/offline-packages/types.js";
import { StateStore } from "../../../../../services/data-manager/src/state.js";

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("configuration fence real PostgreSQL and retained grants", () => {
  it("prepares a full application closure with the production Data Manager target registration", async () => {
    const f = await ownedFenceFixture({ productionRegistration: true });
    try {
      expect(f.input.serviceIds).toContain("app-api");
      expect(f.input.serviceIds).toContain("ops-agent");
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      const receipt = await fence.prepare({ ...f.input, delegation: f.delegation }, "ops-agent");
      expect(receipt.state).toBe("prepared");
      await settledByAgent(f.lease, f.child, receipt);
      expect(
        await control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.child),
      ).toMatchObject({
        outcome: "committed",
        terminalReceiptDigest: control.controlDigest({ kind: "data-configuration-fence", receipt }),
      });
    } finally {
      await f.close();
    }
  }, 60000);

  it("holds an enabled community-extension service in the application closure with the production Data Manager target registration", async () => {
    const f = await ownedFenceFixture({
      productionRegistration: true,
      enabledCommunityServiceIds: ["community-tiles"],
    });
    try {
      expect(DATA_MANAGER_CONTROL_SERVICE_IDS).not.toContain("community-tiles");
      expect(f.input.serviceIds).toContain("community-tiles");
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      const receipt = await fence.prepare({ ...f.input, delegation: f.delegation }, "ops-agent");
      expect(receipt.state).toBe("prepared");
      await settledByAgent(f.lease, f.child, receipt);
      expect(
        await control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.child),
      ).toMatchObject({
        outcome: "committed",
        terminalReceiptDigest: control.controlDigest({ kind: "data-configuration-fence", receipt }),
      });
    } finally {
      await f.close();
    }
  }, 60000);

  it("prepares a terminal logical guard, blocks concurrent admissions, and restores it before new mutation", async () => {
    const f = await ownedFenceFixture(),
      { sql, root, dm, child, input, delegation, lease } = f;
    try {
      const fence = createDataConfigurationMaintenance(sql, dm);
      await fence.startup();
      const receipt = await fence.prepare({ ...input, delegation }, "ops-agent");
      expect(receipt).toMatchObject({ fenceId: child.executionId, state: "prepared", sequence: 0 });
      const rows =
        await sql`SELECT state,operation_key,outcome FROM data_manager.configuration_fence WHERE fence_id=${child.executionId}`;
      expect(rows).toEqual([
        { state: "prepared", operation_key: child.operationKey, outcome: null },
      ]);
      await settledByAgent(lease, child, receipt);
      expect(await control.inspectArtifactTargetLeaseChildSettlement(lease, child)).toMatchObject({
        outcome: "committed",
        terminalReceiptDigest: control.controlDigest({ kind: "data-configuration-fence", receipt }),
      });
      const store = createPostgresDataExecutionStore(sql),
        deadline = Date.now() + 30000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      await expect(
        store.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        ),
      ).rejects.toThrow("configuration_maintenance_busy");
      installDataMutationAdmission(fence);
      let dataEffects = 0;
      const actualDb = drizzle(sql, {
          schema: {
            jobs,
            jobStages,
            feedState,
            offlinePackageJobs,
            offlinePackageJobOwners,
            offlinePackageArtifactReferences,
          },
        }),
        singleFlight = createSingleFlightController({ db: actualDb, admissionSql: sql }),
        journal = control.createDataExecutionControlJournal(dm, sql),
        ownedStore = createPostgresDataExecutionStore(sql, {
          controlJournal: journal,
          configurationFence: fence,
        }),
        runtime = createDataExecutionRuntime({
          store: ownedStore,
          dispatch: async () => {
            dataEffects++;
            throw Error("A prepared guard must reject before dispatch");
          },
        }),
        operationsPolicy = resolveOperationsProfile({ countries: ["de"] }),
        dispatcher = createDataExecutionDispatcher({
          dataDir: join(root, "data"),
          state: new StateStore(join(root, "data")),
          sql,
          singleFlight,
          operationsPolicy,
          runHardlinks: async () => {
            dataEffects++;
            throw Error("Closed generation continuation");
          },
        }),
        receiver = createDataExecutionReceiver({
          runtime,
          installation: dm,
          configurationFence: fence,
          dispatcher,
          operationsPolicy,
        }),
        app = Fastify();
      registerAuth(app, {
        api: "guard-fixture-token-api",
        "ops-agent": "guard-fixture-token",
        "host-cli": "guard-fixture-token-cli",
      });
      registerApi(app, {
        executionReceiver: receiver,
        dataDir: join(root, "data"),
        singleFlight,
        operationsPolicy,
        searchIndexSql: sql,
        bakePredicted: async () => {
          dataEffects++;
          throw Error("Guard must precede bake");
        },
      });
      const beforeRows =
          await sql`SELECT id,metadata,status,finished_at FROM data_manager.jobs ORDER BY id`,
        beforeFences = await sql`SELECT * FROM data_manager.configuration_fence`;
      try {
        // Each mutation comes from a caller whose own token may use its route.
        for (const [url, payload, token] of [
          ["/ambient-places/enabled", { enabled: false }, "guard-fixture-token-api"],
          ["/ambient-places/rollback", {}, "guard-fixture-token-api"],
          ["/transit/sync", { countries: ["de"] }, "guard-fixture-token-api"],
          ["/transit/restart-motis", {}, "guard-fixture-token-api"],
          ["/traffic/predicted/bake", {}, "guard-fixture-token-cli"],
          ["/datasets/reload", {}, "guard-fixture-token-cli"],
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url,
            payload,
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.statusCode, url + response.body).toBe(409);
        }
        await expect(
          singleFlight.tryStartSync({ trigger: "cron", triggeredBy: "fixture" }),
        ).rejects.toThrow("configuration_maintenance_busy");
        await expect(createJobRow({ kind: "traffic-predicted" }, sql)).rejects.toThrow(
          "configuration_maintenance_busy",
        );
        await expect(
          startLegacyDataMutation(
            "traffic-predicted",
            async () => {
              dataEffects++;
            },
            sql,
          ),
        ).rejects.toThrow("configuration_maintenance_busy");
        const offline = new PostgresOfflinePackageAccountingStore(sql),
          candidate: OfflinePackageJobRecord = {
            jobId: randomUUID(),
            request: {
              request: {
                bbox: { west: 1, south: 1, east: 2, north: 2 },
                minZoom: 1,
                maxZoom: 2,
                provider: "openmapx",
              },
              effective: { bbox: { west: 1, south: 1, east: 2, north: 2 }, minZoom: 1, maxZoom: 2 },
              source: {
                datasetId: "openmapx",
                datasetVersion: "fixture",
                sourceMaxZoom: 2,
                sourceBounds: { west: 0, south: 0, east: 3, north: 3 },
                tileSchema: "openmaptiles",
                glyphsVersion: "fixture",
                packageAlgorithmVersion: "pmtiles-area-v1",
                attribution: ["Public fixture"],
              },
              requestKey: "guard-fixture",
            },
            status: "preparing",
            packageId: `omp2-${"a".repeat(64)}`,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
          };
        await expect(
          offline.admit("a".repeat(64), candidate, {
            readManifest: async () => {
              dataEffects++;
              return undefined;
            },
          }),
        ).rejects.toThrow("configuration_maintenance_busy");
        const cron = setupCron({
          dataDir: join(root, "data"),
          countries: ["de"],
          store: new StateStore(join(root, "data")),
          singleFlight,
          executionReceiver: receiver,
          operationsPolicy,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          syncCronExpression: "disabled",
          feedProxyReloadCronExpression: "disabled",
          stalenessCheckCronExpression: "disabled",
          trafficExtractCronExpression: "disabled",
          trafficLiveCronExpression: "disabled",
          trafficPredictedCronExpression: "disabled",
          overtureCronExpression: "disabled",
          overtureConflationRetryCronExpression: "disabled",
          runStalenessCheck: async () => {},
        });
        try {
          await cron.runSyncNow();
        } finally {
          cron.stop();
        }
        expect(dataEffects).toBe(0);
        expect(
          await sql`SELECT id,metadata,status,finished_at FROM data_manager.jobs ORDER BY id`,
        ).toEqual(beforeRows);
        expect(await sql`SELECT * FROM data_manager.configuration_fence`).toEqual(beforeFences);
      } finally {
        await app.close();
        await runtime.close();
        journal.close();
      }
      const restarted = createDataConfigurationMaintenance(sql, dm);
      await restarted.startup();
      await expect(restarted.withAdmission(async () => undefined)).rejects.toThrow(
        "configuration_maintenance_busy",
      );
      await expect(
        fence.prepare({ ...input, candidateId: randomUUID(), delegation }, "ops-agent"),
      ).rejects.toThrow();
      expect(await fence.prepare({ ...input, delegation }, "ops-agent")).toEqual(receipt);
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
    } finally {
      await f.close();
    }
  }, 60000);
});

import { drizzle } from "drizzle-orm/postgres-js";
import { dataManagerTokenFile } from "../../test/data-manager-token";

async function ownedFenceFixture(
  options: {
    productionRegistration?: boolean;
    guardedRecovery?: boolean;
    /** Installed, enabled services outside the release's built-in set. */
    enabledCommunityServiceIds?: string[];
  } = {},
) {
  const fixture = await createConfigurationPostgresFixture({
    withAccountAdministration: options.guardedRecovery,
    withConfigurationMigration: options.guardedRecovery,
  });
  apiState.fixture = fixture;
  const community = options.enabledCommunityServiceIds ?? [];
  const host = await ownedServiceHost({
    withCoordinator: true,
    configurationReleaseMetadata: options.guardedRecovery,
    configurationHelperVersion: options.guardedRecovery ? "1" : undefined,
    selectedRoots: options.productionRegistration
      ? ["app-api", "data-manager", "motis", "ops-agent", ...community]
      : ["data-manager", "motis"],
    extraServiceIds: options.productionRegistration ? community : ["foreign-consumer"],
    schemas: {
      "data-manager": {
        type: "object",
        properties: { TOKEN: { type: "string", "x-openmapx-secret": true } },
      },
    },
  });
  host.setRows([
    host.row,
    {
      ...host.row,
      Id: "c".repeat(64),
      ConfigImage: "example/data-manager:1",
      Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
    },
    ...(options.productionRegistration
      ? ["app-api", "ops-agent"].map((id, index) => ({
          ...host.row,
          Id: (index === 0 ? "d" : "e").repeat(64),
          ConfigImage: `example/${id}:1`,
          Labels: { ...host.row.Labels, "com.docker.compose.service": id },
        }))
      : []),
  ]);
  const serviceIds = host.loaded.map((s) => s.manifest.id),
    dmServiceIds = options.productionRegistration
      ? [...DATA_MANAGER_CONTROL_SERVICE_IDS]
      : serviceIds,
    root = host.infraDir,
    agent = control.openControlInstallation({ infraDir: root, role: "ops-agent", serviceIds }),
    data = await ownedDataManager({
      sql: fixture.sql,
      infraDir: root,
      serviceIds: dmServiceIds,
    }),
    dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: dmServiceIds,
    }),
    app = buildOpsAgentServer({
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      controlInstallation: agent,
      tokens: {
        api: host.token,
        "data-manager": Buffer.alloc(32, 23).toString("base64url"),
      },
      journal: await openOpsJobJournal(join(root, "state/ops-agent/jobs-v1.json")),
    }),
    tokenFile = join(host.root, "api-token");
  writeFileSync(tokenFile, host.token, { mode: 0o600 });
  for (const [key, value] of Object.entries({
    OPS_AGENT_URL: await app.listen({ host: "127.0.0.1", port: 0 }),
    OPS_AGENT_TOKEN_FILE: tokenFile,
    OPENMAPX_ROOT_DIR: host.root,
    OPENMAPX_SECRETS_KEY: "71".repeat(32),
    OPENMAPX_RELEASE: "local",
    BETTER_AUTH_SECRET: "owned-fence-synthetic-secret-at-least-32",
    DOMAIN: "example.test",
    DATA_MANAGER_URL: data.baseUrl,
    DATA_MANAGER_TOKEN_FILE: dataManagerTokenFile(data.token),
  }))
    vi.stubEnv(key, value);
  const { initServiceRegistry } = await import(
    "../../../../../apps/api/src/services/service-registry"
  );
  await initServiceRegistry({ strict: true });
  let checkedRelease: { releaseId: string; manifestDigest: string } | undefined;
  if (options.guardedRecovery) {
    vi.stubEnv("OPENMAPX_RELEASE", "main");
    const manifest = services.parseReleaseManifest(
      JSON.stringify({
        schemaVersion: 1,
        release: "checked-recovered-release-01",
        images: Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((image) => [
            image,
            `ghcr.io/openmapx/${image}@sha256:${"9".repeat(64)}`,
          ]),
        ),
        ...releaseProvenance(),
      }),
    );
    const raw = services.canonicalReleaseManifest(manifest);
    checkedRelease = {
      releaseId: manifest.release,
      manifestDigest: createHash("sha256").update(raw).digest("hex"),
    };
    services.cacheReleaseManifest(host.infraDir, manifest);
  }
  const jobId = randomUUID(),
    actorId = options.guardedRecovery ? randomUUID() : jobId,
    execution = { owner: randomUUID(), version: 1 },
    operationKey = options.guardedRecovery
      ? (await import("../ops-client")).createDurableOpsKey("admin-job.guarded-release", jobId)
      : `opk1_${jobId.replaceAll("-", "")}`,
    jobType = options.guardedRecovery ? "system.update" : "service.apply",
    payload = checkedRelease
      ? {
          operation: "apply",
          workflow: "guarded-release",
          createBackup: false,
          releaseId: checkedRelease.releaseId,
          expectedDigest: checkedRelease.manifestDigest,
        }
      : {},
    initialResult = {};
  if (options.guardedRecovery) {
    await fixture.db.insert(apiSchema.user).values({
      id: actorId,
      name: "Synthetic release administrator",
      email: `${actorId}@example.test`,
      role: "admin",
    });
    const { jobRunner } = await import("../job-runner"),
      { handleSystemUpdateJob } = await import("../system-maintenance");
    jobRunner.register("system.update", handleSystemUpdateJob);
  }
  await fixture.db.insert(apiSchema.adminJob).values({
    id: jobId,
    type: jobType,
    ...(options.guardedRecovery ? { createdBy: actorId } : {}),
    payload,
    status: "running",
    result: initialResult,
    protocol: { execution },
  });
  const ctx: JobContext = {
    jobId,
    jobType,
    execution,
    payload,
    signal: new AbortController().signal,
    checkpointResult: initialResult,
    protocol: { execution },
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (result, progress, admissionKey, stepAddress, operations) => {
      const recorded = operations ?? (ctx.protocol?.operations as typeof operations);
      if (recorded) {
        const { checkpointOwnedAdminJob } = await import(
          "../../../../../apps/api/src/services/admin-job-checkpoint"
        );
        const saved = await checkpointOwnedAdminJob(
          jobId,
          execution,
          result,
          recorded,
          progress,
          admissionKey,
          stepAddress,
          ctx.checkpointResult ?? {},
        );
        ctx.checkpointResult = saved.result;
        ctx.protocol = saved.protocol;
      } else {
        const { replaceJobCheckpoint } = await import("../admin-job-state");
        const [saved] = await fixture.db
          .update(apiSchema.adminJob)
          .set(replaceJobCheckpoint(result))
          .where(eq(apiSchema.adminJob.id, jobId))
          .returning({ protocol: apiSchema.adminJob.protocol });
        ctx.checkpointResult = result;
        ctx.protocol = saved?.protocol;
      }
    },
  };
  const captured = Promise.withResolvers<{
      input: import("@openmapx/core/data-manager-contracts").DataConfigurationFencePrepare;
      delegation: control.ControlDelegation;
    }>(),
    response = Promise.withResolvers<Response>(),
    originalFetch = globalThis.fetch;
  // Hold only the actual signed HTTP request. Tests deliver its exact body to
  // the real receiver/store, including their named SQL crash boundary.
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (
      String(url) === `${data.baseUrl}/executions/configuration-maintenance/prepare` &&
      init?.method === "POST"
    ) {
      const { delegation, ...input } = dataConfigurationFencePrepareRequestSchema.parse(
        JSON.parse(String(init.body)),
      );
      captured.resolve({ input, delegation });
      return response.promise;
    }
    return originalFetch(url, init);
  });
  const writer = await import(
      "../../../../../apps/api/src/services/administrative-configuration-writer"
    ),
    prospective = await import("../../../../../apps/api/src/services/prospective-configuration");
  const preparation = options.guardedRecovery
    ? (await import("../system-release-application")).runGuardedSystemRelease(ctx)
    : writer.withAdministrativeConfigurationJob(ctx, () =>
        writer.withAdministrativeConfigurationWriter(
          { actorId: jobId, operationKey, integrationIds: [] },
          async () => {
            const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: jobId,
              operationKey,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "ensure-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-guard-credential",
                  },
                ],
              },
            });
            // The fixture holds the preparation's data-manager request below.
            return prospective.persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "ensure-running",
            });
          },
        ),
      );
  const pending = preparation.then(
    () => {
      throw Error("Preparation completed before receiver delivery");
    },
    (error) => {
      throw Error(`${String(error)}; ${JSON.stringify(error?.result)}`);
    },
  );
  // The original API producer must reach the actual agent-issued child grant.
  const { input, delegation } = await Promise.race([captured.promise, pending]);
  const child = delegation.execution,
    owner = input.ownerPrepare,
    authority = control.restoreAdmittedControlExecution(agent, owner),
    lease = control.restoreArtifactTargetLeaseForSettlement(authority);
  return {
    sql: fixture.sql,
    root,
    agent,
    dm,
    owner,
    child,
    authority,
    lease,
    delegation,
    input,
    data,
    host,
    ctx,
    async failPreparation() {
      response.resolve(
        new Response(JSON.stringify({ error: "Original receiver admission refused" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      );
      await preparation.catch(() => {});
    },
    async close() {
      response.reject(Error("Named fixture HTTP transport closed"));
      await preparation.catch(() => {});
      transport.mockRestore();
      await app.close();
      await data.close();
      await fixture.sql`DELETE FROM data_manager.configuration_fence WHERE fence_id=${child.executionId}`;
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      control.closeControlInstallation(dm);
      await fixture.stop();
      rmSync(host.cleanupRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    },
  };
}

it.skipIf(!process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL)(
  "blocks a racing real admission while the fence insert is in flight and keeps the unknown leaf held",
  async () => {
    const f = await ownedFenceFixture();
    let release = () => {},
      pause = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        pause = resolve;
      });
    const fence = control.createDataConfigurationFenceStore(f.dm, {
      unsafe: (query, parameters) => f.sql.unsafe(query, parameters),
      async transaction(run) {
        const result = await f.sql.begin(async (tx) => ({
          value: await run({
            unsafe: async (query, parameters) => {
              if (query.startsWith("INSERT INTO data_manager.configuration_fence")) {
                pause();
                await held;
                throw Error("Synthetic process crash before guard insert");
              }
              return tx.unsafe(query, parameters);
            },
          }),
        }));
        return result.value;
      },
    });
    await fence.startup();
    const attempt = fence.prepare({ ...f.input, delegation: f.delegation }, "ops-agent");
    const rejected = expect(attempt).rejects.toThrow("Synthetic process crash");
    try {
      await ready;
      const deadline = Date.now() + 30000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        store = createPostgresDataExecutionStore(f.sql);
      await expect(
        store.admit(
          { kind: "download-fonts" },
          { operationKey: key, requestedDeadlineAt: deadline },
        ),
      ).rejects.toThrow("configuration_maintenance_busy");
      expect(await store.lookup(key)).toBeNull();
      expect(await f.sql`SELECT id FROM data_manager.jobs WHERE id=${f.child.executionId}`).toEqual(
        [],
      );
      release();
      await rejected;
      const restarted = createDataConfigurationMaintenance(f.sql, f.dm);
      await restarted.startup();
      expect(
        await f.sql`SELECT * FROM data_manager.configuration_fence WHERE maintenance_id=${f.input.maintenanceId}::uuid`,
      ).toEqual([]);
      // The begun leaf has no recorded outcome, so the agent's root stays held.
      expect(await control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.child)).toBeNull();
      await expect(control.releaseArtifactTargetLease(f.lease)).rejects.toThrow();
    } finally {
      release();
      await attempt.catch(() => {});
      await f.close();
    }
  },
  60000,
);
it.skipIf(!process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL)(
  "rejects a signed foreign generation owner without changing the prepared guard",
  async () => {
    const f = await ownedFenceFixture(),
      fence = createDataConfigurationMaintenance(f.sql, f.dm),
      host = control.openControlInstallation({
        infraDir: f.root,
        role: "host-cli",
        serviceIds: ["foreign-consumer"],
      });
    let foreignLease: control.ArtifactTargetLease | undefined;
    try {
      await fence.startup();
      await fence.prepare({ ...f.input, delegation: f.delegation }, "ops-agent");
      const before = await f.sql`SELECT * FROM data_manager.configuration_fence`;
      const now = Date.now(),
        deadline = now + 30000,
        operation = { kind: "data.link" as const },
        opHash = createHash("sha256").update(canonicalJson(operation)).digest("hex"),
        owner: ExecutionRef = {
          executor: "host-cli",
          principal: "host-cli",
          executionId: randomUUID(),
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          operationFingerprint: opHash,
          deadlineAt: deadline,
          fingerprint: executionFingerprint({
            kind: operation.kind,
            operationFingerprint: opHash,
            deadlineAt: deadline,
          }),
        },
        plan = { plan: [], prune: true as const },
        planDigest = control.controlDigest(plan);
      const requests = [
        {
          revisionId: f.input.revisionId,
          planDigest,
          coordinatorMode: f.input.coordinatorMode,
        },
      ].map((body, ordinal) => {
        const input = { kind: "generation-hardlinks" as const, ...body },
          hash = createHash("sha256").update(canonicalJson(input)).digest("hex"),
          execution: ExecutionRef = {
            executor: "data-manager",
            principal: "host-cli",
            executionId: randomUUID(),
            operationKey: control.controlChildOperationKey(
              owner.operationKey,
              "hardlinks",
              ordinal,
            ),
            operationFingerprint: hash,
            deadlineAt: deadline,
            fingerprint: executionFingerprint({
              kind: input.kind,
              operationFingerprint: hash,
              deadlineAt: deadline,
              parent: control.retainedControlParent(owner),
            }),
          };
        return {
          input,
          plan,
          slot: {
            phase: "hardlinks" as const,
            ordinal,
            kind: input.kind,
            recipient: "data-manager" as const,
            execution,
            serviceIds: ["foreign-consumer"],
          },
        };
      });
      const authority = control.retainAdmittedControlExecution(host, {
        execution: owner,
        kind: operation.kind,
        operation,
        admittedAt: now,
        requestedDeadlineAt: deadline,
        serviceIds: ["foreign-consumer"],
        plan: requests.map((request) => request.slot),
      });
      foreignLease = await control.acquireArtifactTargetLease({
        serviceIds: ["foreign-consumer"],
        owner: authority,
      });
      for (const request of requests) {
        const delegation = await control.delegateArtifactTargetLease(foreignLease, request.slot);
        await expect(
          fence.assertGenerationAdmission(
            {
              operationKey: request.slot.execution.operationKey,
              requestedDeadlineAt: deadline,
              input: request.input,
              plan,
              delegation,
            },
            "ops-agent",
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(await f.sql`SELECT id FROM data_manager.jobs WHERE execution_version=2`).toEqual([]);
      }
      expect(await f.sql`SELECT * FROM data_manager.configuration_fence`).toEqual(before);
      await expect(
        fence.withAdmission(async () => {
          throw Error("No data effects may run");
        }),
      ).rejects.toThrow("configuration_maintenance_busy");
    } finally {
      if (foreignLease) control.closeArtifactTargetLeaseHandle(foreignLease);
      control.closeControlInstallation(host);
      await f.close();
    }
  },
  60000,
);
