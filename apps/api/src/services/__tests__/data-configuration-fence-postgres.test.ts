import { createHash, randomBytes, randomUUID } from "node:crypto";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { dataConfigurationFencePrepareSchema } from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
} from "@openmapx/core/ops";
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
  it("prepares a terminal logical guard, blocks concurrent admissions, and restores it before new mutation", async () => {
    const f = await ownedFenceFixture(),
      { sql, root, dm, child, input, assertion, lease } = f;
    try {
      const fence = createDataConfigurationMaintenance(sql, dm);
      await fence.startup();
      const receipt = await fence.prepare(input, ["x-openmapx-control-delegation", assertion]);
      expect(receipt).toMatchObject({ fenceId: child.executionId, state: "prepared", sequence: 0 });
      expect(
        existsSync(
          join(
            root,
            "data/.admin-target-control/executions/data-manager",
            `${child.operationKey}.data-terminal.json`,
          ),
        ),
      ).toBe(true);
      const rows =
        await sql`SELECT status,finished_at,metadata FROM data_manager.jobs WHERE id=${child.executionId}`;
      expect(rows[0]?.status).toBe("ok");
      const finishedAt = rows[0]?.finished_at,
        preparedTerminalAt =
          finishedAt instanceof Date ? finishedAt.getTime() : Date.parse(String(finishedAt));
      expect(Number.isFinite(preparedTerminalAt)).toBe(true);
      const preparedSource = control.verifyPublishedDataConfigurationFencePrepared(lease, child);
      expect(control.preparedDataConfigurationFenceState(preparedSource)).toMatchObject({
        preparedReceipt: receipt,
        preparedTerminalAt,
      });
      expect(() =>
        control.preparedDataConfigurationFenceState({} as typeof preparedSource),
      ).toThrow();
      expect(() =>
        control.verifyPublishedDataConfigurationFencePrepared(lease, {
          ...child,
          executionId: randomUUID(),
        }),
      ).toThrow();
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
      registerAuth(app, "guard-fixture-token", { executionReceiver: () => receiver });
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
      const beforeMirror = readFileSync(
          join(
            root,
            "control-private/data-manager/configuration-maintenance",
            `${input.maintenanceId}.json`,
          ),
        ),
        beforeRows =
          await sql`SELECT id,metadata,status,finished_at FROM data_manager.jobs ORDER BY id`;
      try {
        for (const [url, payload] of [
          ["/download/fonts", {}],
          ["/download/osm", { region: "europe/germany/berlin" }],
          ["/search-index/build", { region: "europe/germany/berlin" }],
          ["/notable-places/build", {}],
          ["/transit/sync", { countries: ["de"] }],
          ["/transit/restart-motis", {}],
          ["/traffic/predicted/bake", {}],
          ["/datasets/reload", {}],
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url,
            payload,
            headers: { authorization: "Bearer guard-fixture-token" },
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
        expect(
          readFileSync(
            join(
              root,
              "control-private/data-manager/configuration-maintenance",
              `${input.maintenanceId}.json`,
            ),
          ),
        ).toEqual(beforeMirror);
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
        fence.prepare({ ...input, candidateId: randomUUID() }, [
          "x-openmapx-control-delegation",
          assertion,
        ]),
      ).rejects.toThrow();
      expect(await fence.prepare(input, ["x-openmapx-control-delegation", assertion])).toEqual(
        receipt,
      );
      expect(control.inspectArtifactTargetLeaseChildSettlement(lease, child)?.publication).toBe(
        "committed",
      );
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
    } finally {
      await f.close();
    }
  }, 60000);
});

import { existsSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";

async function ownedFenceFixture() {
  const fixture = await createConfigurationPostgresFixture();
  apiState.fixture = fixture;
  const host = await ownedServiceHost({
    withCoordinator: true,
    selectedRoots: ["data-manager", "motis"],
    extraServiceIds: ["foreign-consumer"],
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
  ]);
  const serviceIds = host.loaded.map((s) => s.manifest.id),
    root = host.infraDir,
    agent = control.openControlInstallation({ infraDir: root, role: "ops-agent", serviceIds }),
    data = await ownedDataManager({ sql: fixture.sql, infraDir: root, serviceIds }),
    dm = control.openControlInstallation({ infraDir: root, role: "data-manager", serviceIds }),
    app = buildOpsAgentServer({
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      controlInstallation: agent,
      tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
      journal: await openOpsJobJournal(join(root, "state/ops-agent/jobs-v1.json")),
    }),
    tokenFile = join(host.root, "api-token");
  writeFileSync(tokenFile, host.token, { mode: 0o600 });
  for (const [key, value] of Object.entries({
    OPS_AGENT_URL: await app.listen({ host: "127.0.0.1", port: 0 }),
    OPS_AGENT_TOKEN_FILE: tokenFile,
    OPS_TRUSTED_CONFIG_DIR: host.queue,
    OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
    OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
    OPENMAPX_ROOT_DIR: host.root,
    OPENMAPX_SECRETS_KEY: "71".repeat(32),
    OPENMAPX_RELEASE: "local",
    BETTER_AUTH_SECRET: "owned-fence-synthetic-secret-at-least-32",
    DOMAIN: "example.test",
    DATA_MANAGER_URL: data.baseUrl,
    DATA_MANAGER_AUTH_TOKEN: data.token,
  }))
    vi.stubEnv(key, value);
  const { initServiceRegistry } = await import(
    "../../../../../apps/api/src/services/service-registry"
  );
  await initServiceRegistry({ strict: true });
  const jobId = randomUUID(),
    execution = { owner: randomUUID(), version: 1 },
    operationKey = `opk1_${jobId.replaceAll("-", "")}`;
  await fixture.db.insert(apiSchema.adminJob).values({
    id: jobId,
    type: "service.apply",
    payload: {},
    status: "running",
    result: { _execution: execution },
  });
  const ctx: JobContext = {
    jobId,
    jobType: "service.apply",
    execution,
    payload: {},
    signal: new AbortController().signal,
    checkpointResult: { _execution: execution },
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (result, progress, admissionKey, stepAddress) => {
      if ((result.opsProjection as { version?: number } | undefined)?.version === 3) {
        const { checkpointOwnedAdminJob } = await import(
          "../../../../../apps/api/src/services/admin-job-checkpoint"
        );
        ctx.checkpointResult = await checkpointOwnedAdminJob(
          jobId,
          execution,
          result,
          progress,
          admissionKey,
          stepAddress,
          ctx.checkpointResult ?? {},
        );
      } else {
        await fixture.db
          .update(apiSchema.adminJob)
          .set({ result })
          .where(eq(apiSchema.adminJob.id, jobId));
        ctx.checkpointResult = result;
      }
    },
  };
  const captured = Promise.withResolvers<{
      input: import("@openmapx/core/data-manager-contracts").DataConfigurationFencePrepare;
      assertion: string;
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
      const assertion = new Headers(init.headers).get("x-openmapx-control-delegation");
      if (!assertion) throw Error("Actual maintenance grant required");
      captured.resolve({
        input: dataConfigurationFencePrepareSchema.parse(JSON.parse(String(init.body))),
        assertion,
      });
      return response.promise;
    }
    return originalFetch(url, init);
  });
  const writer = await import(
      "../../../../../apps/api/src/services/administrative-configuration-writer"
    ),
    prospective = await import("../../../../../apps/api/src/services/prospective-configuration");
  const preparation = writer.withAdministrativeConfigurationJob(ctx, () =>
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
        await prospective.stageProspectiveConfigurationMaintenance(candidate);
        return (
          await import("../../../../../apps/api/src/services/configuration-maintenance")
        ).prepareConfigurationMaintenance(candidate);
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
  const { input, assertion } = await Promise.race([captured.promise, pending]);
  const child = control.inspectArtifactDelegation({
      dataRoot: join(root, "data"),
      assertion,
      installation: dm,
    }).execution,
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
    assertion,
    input,
    async close() {
      response.reject(Error("Named fixture HTTP transport closed"));
      await preparation.catch(() => {});
      transport.mockRestore();
      await app.close();
      await data.close();
      await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${child.executionId}`;
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
  "refuses settlement capacity authority from a valid ordinary prepare grant without the original published reservation preimage",
  async () => {
    const f = await ownedFenceFixture();
    try {
      const peer = control.verifyControlPeer(f.dm, {
        rawHeaders: ["x-openmapx-control-delegation", f.assertion],
        transportPrincipal: "shared-data-manager-bearer",
        execution: f.child,
        kind: "configuration-maintenance.prepare",
      });
      const reservation = join(
          f.root,
          "data/.admin-target-control/executions/ops-agent",
          `${f.owner.operationKey}.configuration-settlement-control.json`,
        ),
        held = `${reservation}.held`;
      expect(() =>
        control.verifyPublishedConfigurationSettlementReservation(f.dm, peer, f.input),
      ).not.toThrow();
      renameSync(reservation, held);
      try {
        expect(() =>
          control.verifyPublishedConfigurationSettlementReservation(f.dm, peer, f.input),
        ).toThrow();
      } finally {
        renameSync(held, reservation);
      }
      expect(() =>
        control.publishedConfigurationSettlementReservationState({} as never, f.dm),
      ).toThrow();
      expect(await f.sql`SELECT id FROM data_manager.jobs WHERE id=${f.child.executionId}`).toEqual(
        [],
      );
      expect(
        existsSync(
          join(
            f.root,
            "control-private/data-manager/configuration-maintenance",
            `${f.input.maintenanceId}.json`,
          ),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  },
);
it.skipIf(!process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL)(
  "retains a half-written signed guard before insert and blocks a racing real admission on another connection",
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
              if (query.startsWith("INSERT INTO data_manager.jobs")) {
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
    const attempt = fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]);
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
      await expect(restarted.startup()).rejects.toThrow(/Half-written/);
      await expect(restarted.withAdmission(async () => undefined)).rejects.toThrow(
        "configuration_maintenance_busy",
      );
      expect(
        existsSync(
          join(
            f.root,
            "control-private/data-manager/configuration-maintenance",
            `${f.input.maintenanceId}.json`,
          ),
        ),
      ).toBe(true);
      expect(control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.child)).toBeNull();
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
  "rejects signed foreign generation owners and changed revision/hash/coordinator without changing the prepared guard",
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
      await fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]);
      const mirror = join(
          f.root,
          "control-private/data-manager/configuration-maintenance",
          `${f.input.maintenanceId}.json`,
        ),
        original = readFileSync(mirror),
        before =
          await f.sql`SELECT metadata,ownership_version FROM data_manager.jobs WHERE id=${f.child.executionId}`;
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
        {
          revisionId: `cfg1_${"b".repeat(43)}`,
          planDigest,
          coordinatorMode: f.input.coordinatorMode,
        },
        {
          revisionId: f.input.revisionId,
          planDigest: "b".repeat(64),
          coordinatorMode: f.input.coordinatorMode,
        },
        {
          revisionId: f.input.revisionId,
          planDigest,
          coordinatorMode:
            f.input.coordinatorMode === "ensure-running"
              ? ("require-running" as const)
              : ("ensure-running" as const),
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
        dataRoot: join(f.root, "data"),
        serviceIds: ["foreign-consumer"],
        owner: authority,
      });
      for (const request of requests) {
        const assertion = await control.delegateArtifactTargetLease(foreignLease, {
          ...request.slot,
          childPublicKey: f.dm.publicKey,
        });
        await expect(
          fence.assertGenerationAdmission(
            {
              operationKey: request.slot.execution.operationKey,
              requestedDeadlineAt: deadline,
              input: request.input,
              plan,
            },
            ["x-openmapx-control-delegation", assertion],
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(await f.sql`SELECT id FROM data_manager.jobs WHERE execution_version=2`).toEqual([]);
      }
      expect(readFileSync(mirror)).toEqual(original);
      expect(
        await f.sql`SELECT metadata,ownership_version FROM data_manager.jobs WHERE id=${f.child.executionId}`,
      ).toEqual(before);
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
