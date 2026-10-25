import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
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
import Fastify from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { registerApi } from "../../api.js";
import { registerAuth } from "../../auth.js";
import { setupCron } from "../../cron.js";
import { PostgresOfflinePackageAccountingStore } from "../../offline-packages/postgres-accounting.js";
import type { OfflinePackageJobRecord } from "../../offline-packages/types.js";
import { StateStore } from "../../state.js";
import { createJobRow } from "../persistence.js";
import { resolveOperationsProfile } from "../transitous/operations-profile.js";
import { createSingleFlightController } from "../transitous/single-flight.js";
import { installDataMutationAdmission } from "./admission.js";
import { createDataConfigurationMaintenance } from "./configuration-maintenance.js";
import { createDataExecutionDispatcher } from "./dispatch.js";
import { startLegacyDataMutation } from "./legacy-mutation.js";
import { createDataExecutionReceiver } from "./receiver.js";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("configuration fence real PostgreSQL and retained grants", () => {
  it("prepares a terminal logical guard, blocks concurrent admissions, and restores it before new mutation", async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-data-fence-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const services = ["data-manager", "motis"],
      agent = control.openControlInstallation({
        infraDir: root,
        role: "ops-agent",
        serviceIds: services,
      }),
      dm = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: services,
      });
    const now = Date.now(),
      deadlineAt = now + 60000,
      rootBody = { kind: "configurationMaintenance.prepare", maintenanceId: randomUUID() },
      operationFingerprint = createHash("sha256").update(canonicalJson(rootBody)).digest("hex");
    const owner: ExecutionRef = {
      executor: "ops-agent",
      principal: "api",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: rootBody.kind, operationFingerprint, deadlineAt }),
    };
    const input = {
      maintenanceId: rootBody.maintenanceId,
      candidateId: randomUUID(),
      ownerPrepare: owner,
      planDigest: "1".repeat(64),
      serviceIds: services,
      revisionId: `cfg1_${"a".repeat(43)}`,
      hardlinkPlanDigest: null,
      coordinatorMode: "require-running" as const,
    };
    const body = { kind: "configuration-maintenance.prepare", ...input },
      bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    const child: ExecutionRef = {
      executor: "data-manager",
      principal: "api",
      executionId: randomUUID(),
      operationKey: control.controlChildOperationKey(owner.operationKey, "configuration-fence", 0),
      operationFingerprint: bodyHash,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: body.kind,
        operationFingerprint: bodyHash,
        deadlineAt,
        parent: control.retainedControlParent(owner),
      }),
    };
    const plan = {
      phase: "configuration-fence" as const,
      ordinal: 0,
      kind: body.kind,
      execution: child,
      serviceIds: services,
      recipient: "data-manager" as const,
    };
    const authority = control.retainAdmittedControlExecution(agent, {
      execution: owner,
      kind: rootBody.kind,
      operation: rootBody,
      admittedAt: now,
      requestedDeadlineAt: deadlineAt,
      serviceIds: services,
      plan: [plan],
    });
    const lease = await control.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: services,
      owner: authority,
    });
    const assertion = await control.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: dm.publicKey,
    });
    try {
      const fence = createDataConfigurationMaintenance(sql, dm);
      await fence.startup();
      const receipt = await fence.prepare(input, ["x-openmapx-control-delegation", assertion]);
      expect(receipt).toMatchObject({ fenceId: child.executionId, state: "prepared", sequence: 0 });
      const rows =
        await sql`SELECT status,finished_at,metadata FROM data_manager.jobs WHERE id=${child.executionId}`;
      expect(rows[0]?.status).toBe("ok");
      expect(rows[0]?.finished_at).toBeInstanceOf(Date);
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
      await sql`DELETE FROM data_manager.jobs WHERE id=${child.executionId}`;
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(dm);
      control.closeControlInstallation(agent);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

import { existsSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";

async function ownedFenceFixture() {
  const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
  if (!url) throw Error("Owned PostgreSQL required");
  const sql = postgres(url, { max: 4 });
  drizzle(sql);
  const root = mkdtempSync(join(tmpdir(), "omx-fence-race-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(root);
  const services = ["data-manager", "motis"],
    agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: [...services, "foreign-consumer"].sort(),
    }),
    dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: [...services, "foreign-consumer"].sort(),
    }),
    now = Date.now(),
    deadlineAt = now + 60000,
    operation = { kind: "configurationMaintenance.prepare", maintenanceId: randomUUID() },
    bodyHash = createHash("sha256").update(canonicalJson(operation)).digest("hex"),
    owner: ExecutionRef = {
      executor: "ops-agent",
      principal: "api",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint: bodyHash,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint: bodyHash,
        deadlineAt,
      }),
    };
  const hardlinkPlanDigest = createHash("sha256")
      .update(canonicalJson({ plan: [], prune: true }))
      .digest("hex"),
    input = {
      maintenanceId: operation.maintenanceId,
      candidateId: randomUUID(),
      ownerPrepare: owner,
      planDigest: "a".repeat(64),
      serviceIds: services,
      revisionId: `cfg1_${"a".repeat(43)}`,
      hardlinkPlanDigest,
      coordinatorMode: "require-running" as const,
    },
    prepare = { kind: "configuration-maintenance.prepare", ...input },
    fingerprint = createHash("sha256").update(canonicalJson(prepare)).digest("hex"),
    child: ExecutionRef = {
      executor: "data-manager",
      principal: "api",
      executionId: randomUUID(),
      operationKey: control.controlChildOperationKey(owner.operationKey, "configuration-fence", 0),
      operationFingerprint: fingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: prepare.kind,
        operationFingerprint: fingerprint,
        deadlineAt,
        parent: control.retainedControlParent(owner),
      }),
    },
    slot = {
      phase: "configuration-fence" as const,
      ordinal: 0,
      kind: prepare.kind,
      execution: child,
      serviceIds: services,
      recipient: "data-manager" as const,
    };
  const authority = control.retainAdmittedControlExecution(agent, {
      execution: owner,
      kind: operation.kind,
      operation,
      admittedAt: now,
      requestedDeadlineAt: deadlineAt,
      serviceIds: services,
      plan: [slot],
    }),
    lease = await control.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: services,
      owner: authority,
    }),
    assertion = await control.delegateArtifactTargetLease(lease, {
      ...slot,
      childPublicKey: dm.publicKey,
    });
  return {
    sql,
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
      await sql`DELETE FROM data_manager.jobs WHERE id=${child.executionId}`;
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      control.closeControlInstallation(dm);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
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
        plan = { plan: [], prune: true as const };
      const requests = [
        {
          revisionId: f.input.revisionId,
          planDigest: f.input.hardlinkPlanDigest,
          coordinatorMode: "require-running" as const,
        },
        {
          revisionId: `cfg1_${"b".repeat(43)}`,
          planDigest: f.input.hardlinkPlanDigest,
          coordinatorMode: "require-running" as const,
        },
        {
          revisionId: f.input.revisionId,
          planDigest: "b".repeat(64),
          coordinatorMode: "require-running" as const,
        },
        {
          revisionId: f.input.revisionId,
          planDigest: f.input.hardlinkPlanDigest,
          coordinatorMode: "ensure-running" as const,
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
