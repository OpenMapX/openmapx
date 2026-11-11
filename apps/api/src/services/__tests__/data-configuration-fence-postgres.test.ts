import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { dataConfigurationFencePrepareSchema } from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  controlTerminalReceiptDigest,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  signMaintenanceRecoveryProof,
  verifyMaintenanceRecoveryProof,
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
  it.each([
    { producer: "immediate", alreadyFailed: false },
    { producer: "immediate", alreadyFailed: true },
    { producer: "immediate", alreadyFailed: "unlink" },
    { producer: "guarded", alreadyFailed: true },
    { producer: "guarded", alreadyFailed: "unlink" },
  ] as const)(
    "discards the recovered original candidate before admitting a subsequent writer ($producer, already failed=$alreadyFailed)",
    async ({ producer, alreadyFailed }) => {
      const f = await ownedFenceFixture({
        productionRegistration: true,
        legacyRegistration: true,
        immediateRecovery: producer === "immediate",
        guardedRecovery: producer === "guarded",
      });
      let fault: ReturnType<typeof vi.spyOn> | undefined,
        faulted = false;
      try {
        const fence = createDataConfigurationMaintenance(f.sql, f.dm);
        await fence.startup();
        await expect(
          fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
        ).rejects.toThrow("Unregistered execution role/targets");
        await f.failPreparation();
        const { cancelAdminJobOperations } = await import("../admin-job-ops"),
          { jobRunner } = await import("../job-runner"),
          candidate = f.ctx.checkpointResult!._configurationCandidate as {
            sealedOperationKey: string;
          },
          canonicalPath = join(
            f.root,
            "control-private/ops-agent/observations",
            `terminal-${f.owner.operationKey}.json`,
          ),
          canonical = readFileSync(canonicalPath);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(f.owner.deadlineAt + 1);
        if (alreadyFailed === true) {
          await vi.waitFor(
            async () =>
              expect(
                await cancelAdminJobOperations(f.ctx.checkpointResult, undefined, {
                  context: f.ctx,
                  jobId: f.ctx.jobId,
                  pollIntervalMs: 1,
                }),
              ).toBe("recovered_failure"),
            { timeout: 15000, interval: 100 },
          );
          // Exact prior-version terminalization: real recovery and copy/ACK,
          // but the original private candidate has not been discarded.
          await f.sql`UPDATE admin_job SET status='failed', finished_at=now(),
            error='Maintenance preparation failed; original ownership was safely released.',
            result=result || jsonb_build_object('_cancelRequestedAt',${new Date().toISOString()}::text)
            WHERE id=${f.ctx.jobId}`;
          const [historical] = await f.sql`SELECT result FROM admin_job WHERE id=${f.ctx.jobId}`;
          for (const changed of ["proof", "candidate", "job"] as const) {
            const altered = structuredClone(historical!.result),
              entry = altered.opsProjection.operations[f.owner.operationKey];
            if (changed === "proof") entry.receiptDelivery.maintenanceRecovery = "changed";
            if (changed === "candidate") altered._configurationCandidate.candidateId = randomUUID();
            if (changed === "job") entry.attempt.apiJobId = randomUUID();
            await f.sql`UPDATE admin_job SET result=${JSON.stringify(altered)}::jsonb WHERE id=${f.ctx.jobId}`;
            await jobRunner.reconcile({ limit: 32 });
            const [refused] =
              await f.sql`SELECT status,result FROM admin_job WHERE id=${f.ctx.jobId}`;
            expect(refused?.status).toBe("failed");
            expect(refused?.result._configurationCandidate.phase).toBe("prepared");
            expect(
              existsSync(join(f.host.queue, ".candidates", `${candidate.sealedOperationKey}.json`)),
            ).toBe(true);
            await f.sql`UPDATE admin_job SET result=${JSON.stringify(historical!.result)}::jsonb WHERE id=${f.ctx.jobId}`;
          }
          const agentUrl = process.env.OPS_AGENT_URL;
          vi.stubEnv("OPS_AGENT_URL", "http://127.0.0.1:0");
          vi.setSystemTime(f.owner.deadlineAt + 120001);
          await jobRunner.reconcile({ limit: 32 });
          const [reclaimed] =
            await f.sql`SELECT status,finished_at FROM admin_job WHERE id=${f.ctx.jobId}`;
          expect(reclaimed?.status).toBe("running");
          expect(reclaimed?.finished_at).toBeNull();
          vi.stubEnv("OPS_AGENT_URL", agentUrl);
        } else {
          if (alreadyFailed === "unlink") {
            // Make the recovered-failure branch conclusive before checking
            // that public cancellation accepts its pending local cleanup.
            await vi.waitFor(
              async () => {
                expect(
                  await cancelAdminJobOperations(f.ctx.checkpointResult, undefined, {
                    context: f.ctx,
                    jobId: f.ctx.jobId,
                    pollIntervalMs: 1,
                  }),
                ).toBe("recovered_failure");
              },
              { timeout: 15000, interval: 100 },
            );
            expect(await jobRunner.cancel(f.ctx.jobId)).toBe(true);
          } else await jobRunner.cancel(f.ctx.jobId);
        }
        if (alreadyFailed === "unlink") {
          const promises = await import("node:fs/promises"),
            actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          fault = vi.spyOn(promises, "unlink").mockImplementation(async (path) => {
            await actual.unlink(path);
            if (
              !faulted &&
              String(path).endsWith(`/.candidates/${candidate.sealedOperationKey}.json`)
            ) {
              faulted = true;
              throw Error("Lost acknowledgement after original inert candidate unlink");
            }
          });
        }
        vi.setSystemTime(f.owner.deadlineAt + 240001);
        await jobRunner.reconcile({ limit: 32 });
        if (alreadyFailed === "unlink") {
          // Cancellation/recovery is asynchronous. Reach the injected real
          // unlink boundary before testing its lost response and later resume.
          let observationTime = Date.now();
          await vi.waitFor(
            async () => {
              if (!faulted) {
                observationTime += 120000;
                vi.setSystemTime(observationTime);
                await jobRunner.reconcile({ limit: 32 });
              }
              expect(faulted).toBe(true);
            },
            { timeout: 15000, interval: 100 },
          );
          expect(
            existsSync(join(f.host.queue, ".candidates", `${candidate.sealedOperationKey}.json`)),
          ).toBe(false);
          const [interrupted] = await f.sql`SELECT result FROM admin_job WHERE id=${f.ctx.jobId}`;
          expect(
            await (await import("../admin-job-ops")).hasRecoveredMaintenanceCandidate(
              interrupted!.result,
              f.ctx.jobId,
            ),
          ).toBe(true);
          const agentUrl = process.env.OPS_AGENT_URL;
          const afterUnlink = Date.now();
          vi.stubEnv("OPS_AGENT_URL", "http://127.0.0.1:0");
          vi.setSystemTime(afterUnlink + 120000);
          await jobRunner.reconcile({ limit: 32 });
          const [unavailable] =
            await f.sql`SELECT status,result FROM admin_job WHERE id=${f.ctx.jobId}`;
          expect(unavailable?.status).toBe("running");
          expect(unavailable?.result._configurationCandidate.phase).toBe(
            "discarding_without_guard",
          );
          vi.stubEnv("OPS_AGENT_URL", agentUrl);
          vi.setSystemTime(afterUnlink + 240000);
          await jobRunner.reconcile({ limit: 32 });
        }
        const [finished] = await f.sql`SELECT status,result FROM admin_job WHERE id=${f.ctx.jobId}`;
        expect(
          finished?.status,
          JSON.stringify({
            candidate: finished?.result._configurationCandidate,
            observation: finished?.result.observation,
          }),
        ).toBe("failed");
        expect(finished?.result._configurationCandidate.phase).toBe("discarded");
        expect(
          existsSync(join(f.host.queue, ".candidates", `${candidate.sealedOperationKey}.json`)),
        ).toBe(false);
        expect(readFileSync(canonicalPath)).toEqual(canonical);
        expect(control.verifyRetainedArtifactTargetRootRelease(f.authority)).toBeDefined();
        expect(f.data.preparePosts).toBe(0);
        expect(f.host.calls.some((args) => args.includes("up") || args.includes("restart"))).toBe(
          false,
        );
        const nextId = randomUUID(),
          execution = { owner: randomUUID(), version: 1 },
          next = {
            ...f.ctx,
            jobId: nextId,
            execution,
            checkpointResult: { _execution: execution },
          },
          writer = await import("../administrative-configuration-writer");
        await f.sql`INSERT INTO admin_job(id,type,status,payload,result)
          VALUES(${nextId},'service.apply','running','{}',${JSON.stringify(next.checkpointResult)}::jsonb)`;
        await expect(
          writer.withAdministrativeConfigurationJob(next, () =>
            writer.withAdministrativeConfigurationWriter(
              {
                actorId: nextId,
                operationKey: `opk1_${nextId.replaceAll("-", "")}`,
                integrationIds: [],
              },
              async () => "next-writer-admitted",
            ),
          ),
        ).resolves.toBe("next-writer-admitted");
      } finally {
        fault?.mockRestore();
        vi.useRealTimers();
        await f.close();
      }
    },
    90000,
  );

  it("serializes receiver admission with original-root cancellation and negative settlement", async () => {
    const f = await ownedFenceFixture({ productionRegistration: true }),
      authority = await import(
        "../../../../../packages/core/src/build-artifacts/control-authority"
      ),
      retain = authority.retainAdmittedControlExecution;
    let cancellation: Promise<readonly ExecutionRef[]> | undefined;
    const admission = vi
      .spyOn(authority, "retainAdmittedControlExecution")
      .mockImplementation((installation, input) => {
        if (
          installation.role === "data-manager" &&
          input.kind === "configuration-maintenance.prepare" &&
          !cancellation
        ) {
          cancellation = control.cancelArtifactTargetLease(f.lease);
          void cancellation.catch(() => {});
        }
        return retain(installation, input);
      });
    try {
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      await expect(
        fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
      ).resolves.toMatchObject({ state: "prepared" });
      expect(cancellation).toBeDefined();
      await expect(cancellation!).rejects.toThrow("Lease journal writer is busy");
    } finally {
      admission.mockRestore();
      await f.close();
    }
  }, 60000);

  it("keeps ownership when negative receiver evidence is live, changed, admitted, or unavailable", async () => {
    const f = await ownedFenceFixture({ productionRegistration: true, legacyRegistration: true });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const request = (input = f.input, headers: Record<string, string> = {}) =>
      fetch(`${f.data.baseUrl}/executions/configuration-maintenance/recovery`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.data.token}`,
          "content-type": "application/json",
          "x-openmapx-control-delegation": f.assertion,
          ...headers,
        },
        body: JSON.stringify(input),
      });
    try {
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      await expect(
        fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
      ).rejects.toThrow("Unregistered execution role/targets");
      expect((await request()).status).not.toBe(200); // live original
      clock = vi.spyOn(Date, "now").mockReturnValue(f.owner.deadlineAt + 1);
      expect((await request()).status).not.toBe(200); // issuer not frozen
      control.cancelControlExecution(f.authority);
      await control.cancelArtifactTargetLease(f.lease);
      expect((await request(f.input, { authorization: "Bearer wrong" })).status).toBe(401);
      expect(
        (await request(f.input, { "x-openmapx-control-delegation": "changed" })).status,
      ).not.toBe(200);
      expect((await request({ ...f.input, candidateId: randomUUID() })).status).not.toBe(200);
      const delegation = JSON.parse(Buffer.from(f.assertion, "base64url").toString("utf8")),
        adoptionFile = join(
          f.root,
          "control-private/data-manager/adoptions",
          `${delegation.delegationId}.json`,
        ),
        adoption = readFileSync(adoptionFile, "utf8");
      writeFileSync(
        adoptionFile,
        JSON.stringify({ ...JSON.parse(adoption), state: "pending-adoption" }),
      );
      try {
        expect((await request()).status).not.toBe(200);
      } finally {
        writeFileSync(adoptionFile, adoption);
      }
      for (const identity of ["key", "id", "maintenance"] as const) {
        const id = identity === "id" ? f.child.executionId : randomUUID(),
          key =
            identity === "key" ? f.child.operationKey : `opk1_${randomUUID().replaceAll("-", "")}`,
          kind = identity === "maintenance" ? "configuration-maintenance" : "download-fonts",
          metadata =
            identity === "maintenance"
              ? {
                  configurationMaintenance: {
                    version: 1,
                    guardState: "prepared",
                    input: f.input,
                    receipt: {
                      maintenanceId: f.input.maintenanceId,
                      candidateId: f.input.candidateId,
                      ownerPrepare: f.owner,
                      planDigest: f.input.planDigest,
                      revisionId: f.input.revisionId,
                      hardlinkPlanDigest: f.input.hardlinkPlanDigest,
                      fenceId: id,
                      sequence: 0,
                      state: "prepared",
                    },
                  },
                }
              : {};
        await f.sql`INSERT INTO data_manager.jobs(id,kind,status,operation_key,metadata) VALUES(${id},${kind},'ok',${key},${JSON.stringify(metadata)}::jsonb)`;
        try {
          expect((await request()).status).not.toBe(200);
        } finally {
          await f.sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
        }
      }
      for (const [namespace, name] of [
        ["executions", `${f.child.operationKey}.json`],
        ["effects", `${f.child.operationKey}.json`],
        ["effect-started", `${f.child.operationKey}.json`],
        ["configuration-maintenance", `${f.input.maintenanceId}.json`],
      ]) {
        const directory = join(f.root, "control-private/data-manager", namespace!),
          file = join(directory, name!);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(file, "null", { mode: 0o600 });
        try {
          expect((await request()).status).not.toBe(200);
        } finally {
          unlinkSync(file);
        }
      }
      await f.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${0x4f4d58},2)`;
        expect((await request()).status).not.toBe(200);
      });
      expect(() => control.verifyRetainedArtifactTargetRootRelease(f.authority)).toThrow();
      const assertion = JSON.parse(Buffer.from(f.assertion, "base64url").toString("utf8")),
        childFile = join(
          f.root,
          "data/.admin-target-control/leases",
          assertion.leaseId,
          "children",
          `${assertion.delegationId}.json`,
        );
      expect(JSON.parse(readFileSync(childFile, "utf8")).payload.phase).toBe("held");
    } finally {
      clock?.mockRestore();
      await f.close();
    }
  }, 60000);

  it("cancels the original failed preparation without changing its canonical or replaying PREPARE", async () => {
    const f = await ownedFenceFixture({
      productionRegistration: true,
      legacyRegistration: true,
      loseRecoveryResponseOnce: true,
    });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      await expect(
        fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
      ).rejects.toThrow("Unregistered execution role/targets");
      await f.failPreparation();
      const { createApiOpsClient } = await import("../ops-client"),
        client = createApiOpsClient(),
        original = await client.status("configurationMaintenance.prepare", f.owner.executionId);
      expect(original).toMatchObject({ state: "failed", errorClass: "recovery_required" });
      clock = vi.spyOn(Date, "now").mockReturnValue(f.owner.deadlineAt + 1);
      const { cancelAdminJobOperations } = await import("../admin-job-ops");
      vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:0");
      expect(
        await cancelAdminJobOperations(f.ctx.checkpointResult, client, {
          context: f.ctx,
          jobId: f.ctx.jobId,
          pollIntervalMs: 1,
        }),
      ).toBe("pending");
      expect(() => control.verifyRetainedArtifactTargetRootRelease(f.authority)).toThrow();
      vi.stubEnv("DATA_MANAGER_URL", f.data.baseUrl);
      const cancel = client.cancel.bind(client),
        legacy = vi.spyOn(client, "cancel").mockImplementation(async (...args) => {
          const { diagnostics: _diagnostics, ...status } = await cancel(...args);
          return status; // an older agent cannot attest original ownership closure
        });
      expect(
        await cancelAdminJobOperations(f.ctx.checkpointResult, client, {
          context: f.ctx,
          jobId: f.ctx.jobId,
          pollIntervalMs: 1,
        }),
      ).toBe("pending");
      expect(() => control.verifyRetainedArtifactTargetRootRelease(f.authority)).toThrow();
      expect(
        await cancelAdminJobOperations(f.ctx.checkpointResult, client, {
          context: f.ctx,
          jobId: f.ctx.jobId,
          pollIntervalMs: 1,
        }),
      ).toBe("pending");
      legacy.mockRestore();
      for (const change of ["token", "candidate", "canonical"] as const) {
        const altered = vi.spyOn(client, "cancel").mockImplementation(async (...args) => {
          const status = await cancel(...args),
            proof = verifyMaintenanceRecoveryProof(
              f.host.token,
              status.diagnostics!.maintenanceRecovery!,
            );
          return {
            ...status,
            diagnostics: {
              ...status.diagnostics!,
              maintenanceRecovery: signMaintenanceRecoveryProof(
                change === "token" ? "other-token" : f.host.token,
                {
                  ...proof,
                  ...(change === "candidate" ? { candidateId: randomUUID() } : {}),
                  ...(change === "canonical" ? { terminalDigest: "f".repeat(64) } : {}),
                },
              ),
            },
          };
        });
        try {
          expect(
            await cancelAdminJobOperations(f.ctx.checkpointResult, client, {
              context: f.ctx,
              jobId: f.ctx.jobId,
              pollIntervalMs: 1,
            }),
          ).toBe("pending");
        } finally {
          altered.mockRestore();
        }
      }
      expect(
        await cancelAdminJobOperations(f.ctx.checkpointResult, client, {
          context: f.ctx,
          jobId: f.ctx.jobId,
          pollIntervalMs: 1,
        }),
      ).toBe("recovered_failure");
      // A new API cancellation context can complete the durable copy/ACK even
      // while the agent is unreachable; it does not infer recovery from a flag.
      vi.stubEnv("OPS_AGENT_URL", "http://127.0.0.1:0");
      const { jobRunner } = await import("../job-runner");
      expect(await jobRunner.cancel(f.ctx.jobId)).toBe(true);
      const [finished] =
        await f.sql`SELECT status,finished_at,result FROM admin_job WHERE id=${f.ctx.jobId}`;
      expect(finished?.status).toBe("failed");
      expect(finished?.finished_at).not.toBeNull();
      expect(finished?.result._cancelRequestedAt).toBeDefined();
      expect(control.verifyRetainedArtifactTargetRootRelease(f.authority)).toBeDefined();
      expect(await client.status("configurationMaintenance.prepare", f.owner.executionId)).toEqual(
        original,
      );
      expect(
        controlTerminalReceiptDigest(
          await client.cancel(f.owner.executionId, { fingerprint: f.owner.fingerprint }),
        ),
      ).toBe(controlTerminalReceiptDigest(original));
      expect(f.data.preparePosts).toBe(0);
      expect(f.data.recoveryPosts).toBe(1);
      expect(
        await f.sql`SELECT id FROM data_manager.jobs WHERE id=${f.child.executionId}`,
      ).toHaveLength(0);
      const maintenance = await import(
          "../../../../../apps/ops-agent/src/configuration-maintenance-store"
        ),
        origin = maintenance.readOwnedConfigurationMaintenance(f.authority).origin,
        locations = ["ops-agent", "data-manager"].map((role) =>
          join(
            f.root,
            "control-private",
            role,
            "retention-locations",
            `${control.controlDigest(origin)}.json`,
          ),
        );
      const closedAt = Date.now();
      clock.mockReturnValue(closedAt + 71 * 3600000);
      await control.reconcileControlRetention(f.agent, { maxFamilies: 64 });
      await f.data.reconcileRetention();
      expect(locations.map(existsSync)).toEqual([true, true]);
      clock.mockReturnValue(origin.notAfter + 96 * 3600000);
      const delegation = JSON.parse(Buffer.from(f.assertion, "base64url").toString("utf8")),
        adoptionPath = join(
          f.root,
          "control-private/data-manager/adoptions",
          `${delegation.delegationId}.json`,
        ),
        adoptionBytes = readFileSync(adoptionPath);
      try {
        writeFileSync(adoptionPath, "null");
        await control.reconcileControlRetention(f.agent, { maxFamilies: 64 });
        await f.data.reconcileRetention();
        expect(locations.map(existsSync)).toEqual([true, true]);
      } finally {
        writeFileSync(adoptionPath, adoptionBytes);
      }
      for (let round = 0; round < 12 && locations.some(existsSync); round++) {
        await control.reconcileControlRetention(f.agent, { maxFamilies: 64 });
        await f.data.reconcileRetention();
      }
      const remaining = locations.map((path) => {
        if (!existsSync(path)) return { retired: true };
        const retained = JSON.parse(readFileSync(path, "utf8")),
          progress = JSON.parse(
            readFileSync(
              join(path, "../../retention-families", retained.name, "progress.json"),
              "utf8",
            ),
          );
        return {
          phase: progress.phase,
          lastError: progress.lastError,
          executions: progress.executions,
          intents: progress.intents,
          leases: progress.leases,
        };
      });
      expect(locations.map(existsSync), JSON.stringify(remaining)).toEqual([false, false]);
    } finally {
      clock?.mockRestore();
      await f.close();
    }
  }, 60000);

  it.each(["child", "owner", "bundle", "link", "release"] as const)(
    "rejoins only original negative recovery after lost %s publication acknowledgement",
    async (boundary) => {
      const f = await ownedFenceFixture({ productionRegistration: true, legacyRegistration: true });
      let clock: ReturnType<typeof vi.spyOn> | undefined,
        fault: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const fence = createDataConfigurationMaintenance(f.sql, f.dm);
        await fence.startup();
        await expect(
          fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
        ).rejects.toThrow("Unregistered execution role/targets");
        await f.failPreparation();
        const canonicalPath = join(
            f.root,
            "control-private/ops-agent/observations",
            `terminal-${f.owner.operationKey}.json`,
          ),
          canonical = readFileSync(canonicalPath),
          assertion = JSON.parse(Buffer.from(f.assertion, "base64url").toString("utf8")),
          suffix =
            boundary === "child"
              ? `${assertion.delegationId}.json`
              : boundary === "owner"
                ? `${f.input.maintenanceId}.json`
                : boundary === "bundle"
                  ? `${f.owner.operationKey}.configuration-settlement.json`
                  : boundary === "link"
                    ? `${f.owner.operationKey}.configuration-settlement-control.json`
                    : "admission.json",
          nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync,
          maintenance = await import(
            "../../../../../apps/ops-agent/src/configuration-maintenance-store"
          );
        let faulted = false;
        clock = vi.spyOn(Date, "now").mockReturnValue(f.owner.deadlineAt + 1);
        fault = vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
          nativeRename(source, target);
          if (!faulted && String(target).endsWith(suffix)) {
            faulted = true;
            throw Error("Named acknowledgement loss after original recovery publication");
          }
        });
        const recovery = maintenance.recoverUnadmittedConfigurationMaintenance(
          f.host.runtime,
          f.authority,
        );
        // The DM publication can be read from the exact child after its lost
        // HTTP reply, so that case may finish without another operator request.
        if (boundary === "child")
          await expect(recovery).resolves.toMatchObject({ maintenanceId: f.input.maintenanceId });
        else await expect(recovery).rejects.toThrow();
        fault.mockRestore();
        expect(faulted).toBe(true);
        await maintenance.recoverUnadmittedConfigurationMaintenance(f.host.runtime, f.authority);
        expect(control.verifyRetainedArtifactTargetRootRelease(f.authority)).toBeDefined();
        expect(readFileSync(canonicalPath)).toEqual(canonical);
        expect(f.data.preparePosts).toBe(0);
        expect(f.data.recoveryPosts).toBe(1);
        expect(
          await f.sql`SELECT id FROM data_manager.jobs WHERE id=${f.child.executionId}`,
        ).toHaveLength(0);
      } finally {
        fault?.mockRestore();
        clock?.mockRestore();
        await f.close();
      }
    },
    60000,
  );

  it("settles only the expired adopted but unadmitted original preparation through receiver recovery", async () => {
    const f = await ownedFenceFixture({ productionRegistration: true, legacyRegistration: true });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      await expect(
        fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]),
      ).rejects.toThrow("Unregistered execution role/targets");
      const assertion = JSON.parse(Buffer.from(f.assertion, "base64url").toString("utf8")),
        adoption = join(
          f.root,
          "control-private/data-manager/adoptions",
          `${assertion.delegationId}.json`,
        ),
        originalAdoption = readFileSync(adoption, "utf8"),
        execution = join(
          f.root,
          "control-private/data-manager/executions",
          `${f.child.operationKey}.json`,
        );
      expect(JSON.parse(originalAdoption).state).toBe("ready");
      expect(existsSync(execution)).toBe(false);
      clock = vi.spyOn(Date, "now").mockReturnValue(f.owner.deadlineAt + 1);
      control.cancelControlExecution(f.authority);
      await control.cancelArtifactTargetLease(f.lease);
      const response = await fetch(
        `${f.data.baseUrl}/executions/configuration-maintenance/recovery`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.data.token}`,
            "content-type": "application/json",
            "x-openmapx-control-delegation": f.assertion,
          },
          body: JSON.stringify(f.input),
        },
      );
      expect(response.status).toBe(200);
      const proof = await response.json();
      expect(proof.payload).toMatchObject({
        kind: "configuration-prepare-not-admitted",
        input: f.input,
        child: f.child,
      });
      expect(readFileSync(adoption, "utf8")).toBe(originalAdoption);
      expect(existsSync(execution)).toBe(false);
      const child = JSON.parse(
        readFileSync(
          join(
            f.root,
            "data/.admin-target-control/leases",
            assertion.leaseId,
            "children",
            `${assertion.delegationId}.json`,
          ),
          "utf8",
        ),
      );
      expect(child.payload).toMatchObject({
        phase: "settled",
        settlement: { outcome: "failed_without_effect", publication: "not_started" },
      });
      expect(
        await f.sql`SELECT id FROM data_manager.jobs WHERE id=${f.child.executionId}`,
      ).toHaveLength(0);
      const maintenance = await import(
        "../../../../../apps/ops-agent/src/configuration-maintenance-store"
      );
      await maintenance.closeOwnedConfigurationMaintenanceWithoutGuard(f.host.runtime, f.authority);
      expect(
        await control.reconcileArtifactTargetLease({
          dataRoot: join(f.root, "data"),
          leaseId: assertion.leaseId,
          authority: control.verifyControlRecoveryAuthority(f.authority),
        }),
      ).toBe("released");
      expect(control.verifyRetainedArtifactTargetRootRelease(f.authority)).toBeDefined();
    } finally {
      clock?.mockRestore();
      await f.close();
    }
  }, 60000);

  it("prepares a full application closure with the production Data Manager target registration", async () => {
    const f = await ownedFenceFixture({ productionRegistration: true });
    try {
      expect(f.input.serviceIds).toContain("app-api");
      expect(f.input.serviceIds).toContain("ops-agent");
      const fence = createDataConfigurationMaintenance(f.sql, f.dm);
      await fence.startup();
      const receipt = await fence.prepare(f.input, ["x-openmapx-control-delegation", f.assertion]);
      expect(receipt.state).toBe("prepared");
      expect(
        control.preparedDataConfigurationFenceState(
          control.verifyPublishedDataConfigurationFencePrepared(f.lease, f.child),
        ).preparedReceipt,
      ).toEqual(receipt);
    } finally {
      await f.close();
    }
  }, 60000);

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
          ["/ambient-places/enabled", { enabled: false }],
          ["/ambient-places/rollback", {}],
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

async function ownedFenceFixture(
  options: {
    productionRegistration?: boolean;
    legacyRegistration?: boolean;
    loseRecoveryResponseOnce?: boolean;
    immediateRecovery?: boolean;
    guardedRecovery?: boolean;
  } = {},
) {
  const fixture = await createConfigurationPostgresFixture({
    withAccountAdministration: options.guardedRecovery,
    withConfigurationMigration: options.guardedRecovery,
  });
  apiState.fixture = fixture;
  const host = await ownedServiceHost({
    withCoordinator: true,
    configurationReleaseMetadata: options.guardedRecovery,
    configurationHelperVersion: options.guardedRecovery ? "1" : undefined,
    selectedRoots: options.productionRegistration
      ? ["app-api", "data-manager", "motis", "ops-agent"]
      : ["data-manager", "motis"],
    extraServiceIds: options.productionRegistration ? [] : ["foreign-consumer"],
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
    dmServiceIds = options.legacyRegistration
      ? ["data-manager", "motis", "motis-feed-proxy", "motis-staging"]
      : options.productionRegistration
        ? [...DATA_MANAGER_CONTROL_SERVICE_IDS]
        : serviceIds,
    root = host.infraDir,
    agent = control.openControlInstallation({ infraDir: root, role: "ops-agent", serviceIds }),
    data = await ownedDataManager({
      sql: fixture.sql,
      infraDir: root,
      serviceIds: dmServiceIds,
      loseRecoveryResponseOnce: options.loseRecoveryResponseOnce,
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
        privacyReleaseValidation: {
          version: 1,
          sourceBuildFingerprint: "f".repeat(64),
          validatedAt: "2026-10-30T00:00:00.000Z",
          checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
        },
        ...releaseProvenance(),
      }),
    );
    const raw = services.canonicalReleaseManifest(manifest);
    checkedRelease = {
      releaseId: manifest.release,
      manifestDigest: createHash("sha256").update(raw).digest("hex"),
    };
    mkdirSync(services.releaseStatePaths(host.infraDir).store, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(services.releaseStatePaths(host.infraDir).store, `${manifest.release}.json`),
      raw,
      { mode: 0o600 },
    );
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
      : options.immediateRecovery
        ? { operationKey }
        : {},
    initialResult = {
      _execution: execution,
      ...(options.immediateRecovery
        ? {
            _immediateJobId: jobId,
            _immediateActorId: actorId,
            _immediateIntentDigest: "a".repeat(64),
          }
        : {}),
    };
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
  });
  const ctx: JobContext = {
    jobId,
    jobType,
    execution,
    payload,
    signal: new AbortController().signal,
    checkpointResult: initialResult,
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
