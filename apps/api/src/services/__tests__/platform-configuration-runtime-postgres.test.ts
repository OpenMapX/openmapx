/** Actual API candidate -> production registry/agent -> real DM HTTP/SQL guard.
 * Docker I/O is substituted. This qualifies preparation, launch reconciliation
 * and real child adoption; not native helper application/public platform HTTP. */
import { randomUUID } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  restoreAdmittedControlExecution,
} from "@openmapx/core/build-artifacts";
import { configurationMaintenanceSettleRequestDigest } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import type { JobContext } from "../job-runner";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  services: [] as services.LoadedService[],
}));
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({ list: () => state.services }),
}));
const writer = await import("../administrative-configuration-writer-owner");
const { withConfigurationCommitParticipant } = await import("../configuration-commit-participant");
const { preparePlatformConfigurationChange, platformConfigurationParticipation } = await import(
  "../platform-configuration-participant"
);
const prospective = await import("../prospective-configuration");
const { createApiOpsClient, createDurableOpsKey, executeAndWait } = await import("../ops-client");
const { retainPlatformPreview } = await import("../platform-preview-store");
const { loadAuthPolicy } = await import("../../account/auth-policy");
const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "owned platform preparation",
  () => {
    beforeEach(async () => {
      state.fixture = await createMigratedPostgresFixture();
    }, 90000);
    afterEach(async () => {
      await state.fixture?.stop();
    });
    it.each(["old", "1", "launch", "launch-lost"])(
      "guards and retains helper mode %s through original ownership",
      async (version) => {
        const ids = [
          "motis",
          "ops-agent",
          "app-api",
          "traefik",
          "postgis",
          "redis",
          "data-manager",
        ];
        const host = await ownedServiceHost({
          withCoordinator: true,
          selectedRoots: ids,
          environment: {
            "ops-agent": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
            "app-api": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
          },
          configurationHelperVersion: version.startsWith("launch") ? "1" : version,
          configurationHelperLaunchResponseLoss: version === "launch-lost",
          actualComposeConfig: true,
        });
        state.services = host.loaded;
        host.setRows(
          ids.map((id, index) => ({
            ...host.row,
            Id: String(index + 1).repeat(64),
            ConfigImage: `example/${id}:1`,
            Labels: { ...host.row.Labels, "com.docker.compose.service": id },
          })),
        );
        const installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: ids,
        });
        const dm = await ownedDataManager({
          sql: state.fixture.sql,
          infraDir: host.infraDir,
          serviceIds: ids,
        });
        const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
        const app = buildOpsAgentServer({
          tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
          runtime: host.runtime,
          resourceClaimer: host.claimer,
          journal,
          controlInstallation: installation,
        });
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        const tokenFile = join(host.root, "platform-api-token");
        writeFileSync(tokenFile, host.token, { mode: 0o600 });
        for (const [key, value] of Object.entries({
          OPS_AGENT_URL: url,
          OPS_AGENT_TOKEN_FILE: tokenFile,
          OPS_TRUSTED_CONFIG_DIR: host.queue,
          OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
          OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
          OPENMAPX_SECRETS_KEY: "31".repeat(32),
          DOMAIN: "example.test",
          DATA_MANAGER_URL: dm.baseUrl,
          DATA_MANAGER_AUTH_TOKEN: dm.token,
        }))
          vi.stubEnv(key, value);
        try {
          const actorId = randomUUID(),
            jobId = randomUUID(),
            execution = { owner: randomUUID(), version: 1 },
            operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
          await state.fixture.db.insert(schema.user).values({
            id: actorId,
            name: "Synthetic admin",
            email: `${actorId}@example.test`,
            role: "admin",
          });
          await state.fixture.db.insert(schema.adminJob).values({
            id: jobId,
            type: "platform.apply",
            status: "running",
            createdBy: actorId,
            result: { _execution: execution },
          });
          const ctx: JobContext = {
            jobId,
            jobType: "platform.apply",
            execution,
            payload: {},
            signal: new AbortController().signal,
            checkpointResult: { _execution: execution },
            log: async () => {},
            setProgress: async () => {},
            checkpoint: async (result, progress, key, address) => {
              if ((result.opsProjection as { version?: number })?.version === 3)
                ctx.checkpointResult = await checkpointOwnedAdminJob(
                  jobId,
                  execution,
                  result,
                  progress,
                  key,
                  address,
                  ctx.checkpointResult ?? {},
                );
              else {
                await state.fixture.db
                  .update(schema.adminJob)
                  .set({ result })
                  .where(eq(schema.adminJob.id, jobId));
                ctx.checkpointResult = result;
              }
            },
          };
          await writer.withAdministrativeConfigurationJob(ctx, () =>
            writer.withAdministrativeConfigurationWriter(
              { actorId, operationKey, integrationIds: [] },
              async (owned) => {
                const source = await executeAndWait(
                  createApiOpsClient(),
                  { kind: "configuration.sources.inspect" },
                  createDurableOpsKey("platform.sources", jobId),
                );
                const policy = await loadAuthPolicy(state.fixture.db);
                const preview = services.buildPlatformConfigurationPreview({
                  actorId,
                  previewId: randomUUID(),
                  authPolicyRevision: policy.revision,
                  sourceRevision: source.sourceRevision,
                  currentRevisionId: source.revisionId,
                  expectedCurrentRevisionId: source.revisionId,
                  currentPlatform: source.platform,
                  changes: { version: 1, backupRetentionDays: { source: "database", value: 14 } },
                  env: process.env,
                  services: state.services,
                });
                await retainPlatformPreview(
                  {
                    actorId,
                    operationKey,
                    requestFingerprint: "a".repeat(64),
                    preview,
                    sourceSnapshot: source,
                    desiredRowVersion: null,
                  },
                  state.fixture.db,
                );
                const intent = await preparePlatformConfigurationChange(
                  {
                    previewFingerprint: preview.previewFingerprint,
                    expectedCurrentRevisionId: source.revisionId,
                    confirmations: preview.requiredConfirmation,
                  },
                  owned,
                );
                const participation = platformConfigurationParticipation(intent, owned);
                const run = () =>
                  withConfigurationCommitParticipant(owned, participation.participant, async () => {
                    const candidate = await prospective.prepareProspectiveConfiguration({
                      actorId,
                      operationKey,
                      expectedCurrentRevisionId: source.revisionId,
                      overlay: participation.overlay,
                    });
                    await prospective.stageProspectiveConfigurationMaintenance(candidate);
                    await prospective.prepareConfigurationMaintenance(candidate);
                    if (version.startsWith("launch")) {
                      const decision =
                        await prospective.commitProspectiveConfigurationMaintenance(candidate);
                      await prospective.decideConfigurationMaintenance(decision);
                      const prepared = await prospective.inspectConfigurationMaintenance({
                        maintenanceId:
                          prospective.validatedConfigurationCandidateState(candidate).record
                            .maintenanceId!,
                        candidateId: candidate.candidateId,
                      });
                      for (const step of prepared.steps)
                        await prospective.executeConfigurationMaintenanceStep(
                          candidate,
                          step.ordinal,
                        );
                      expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                      // Reattachment observes the same terminal preparation;
                      // it cannot consume another dispatch ticket/create again.
                      await prospective.executeConfigurationMaintenanceStep(
                        candidate,
                        prepared.steps.at(-1)!.ordinal,
                      );
                      expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                    }
                    return candidate;
                  });
                if (version === "old")
                  await expect(run()).rejects.toMatchObject({
                    result: { configurationPreflight: { errorClass: "host_update_required" } },
                  });
                else {
                  let candidate: Awaited<
                    ReturnType<typeof prospective.prepareProspectiveConfiguration>
                  >;
                  try {
                    candidate = await run();
                  } catch (error) {
                    console.info(
                      "platform-step-status",
                      journal.records().map((job) => ({
                        kind: job.operation.kind,
                        state: job.state,
                        errorClass: job.errorClass,
                      })),
                    );
                    const value = error as {
                      result?: { errorCode?: unknown; configurationPreflight?: unknown };
                    };
                    console.info(
                      "platform-preflight-diagnostic",
                      JSON.stringify({
                        errorCode: value.result?.errorCode,
                        preflight: value.result?.configurationPreflight,
                      }),
                    );
                    throw error;
                  }
                  const retained = ctx.checkpointResult?._configurationMaintenance as
                    | { phase?: string; receipt?: { state?: string; steps?: { phase: string }[] } }
                    | undefined;
                  expect(retained?.receipt?.state).toBe(
                    version.startsWith("launch") ? "authorized" : "prepared",
                  );
                  expect(retained?.receipt?.steps?.at(-1)?.phase).toBe("maintenance-handoff");
                  expect(candidate.affectedServiceIds).toEqual(["app-api", "ops-agent"]);
                  const receipt = await prospective.inspectConfigurationMaintenance({
                    maintenanceId:
                      prospective.validatedConfigurationCandidateState(candidate).record
                        .maintenanceId!,
                    candidateId: candidate.candidateId,
                  });
                  const { readOwnedConfigurationMaintenance } = await import(
                    "../../../../ops-agent/src/configuration-maintenance-store"
                  );
                  const owner = readOwnedConfigurationMaintenance(
                    restoreAdmittedControlExecution(installation, receipt.prepare),
                  );
                  expect(owner.plan.handoff?.expectedImageIdentities).toEqual({
                    "app-api": host.row.Image,
                    "ops-agent": host.row.Image,
                  });
                  expect(owner.plan.nestedHandoff?.recipient).toBe("configuration-helper");
                  expect(receipt.binding.expectedSourceRevision).toBe(source.sourceRevision);
                  if (version.startsWith("launch")) {
                    expect(receipt).toMatchObject({
                      state: "applying",
                      followUp: "unknown",
                      dmFence: { state: "prepared" },
                    });
                    await expect(dm.assertDataAdmission()).rejects.toThrow();
                    const [saved] = await state.fixture.db
                      .select()
                      .from(schema.systemSettings)
                      .where(eq(schema.systemSettings.key, "platformConfiguration"));
                    expect(saved?.value).toMatchObject({
                      candidateId: candidate.candidateId,
                      revisionId: candidate.revisionId,
                    });
                    expect(dm.settlePosts).toBe(0);
                    const blocked = await fetch(`${url}/v1/operations`, {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${host.token}`,
                        "x-ops-protocol-version": "2",
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({
                        version: 2,
                        requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
                        operationKey: createDurableOpsKey("platform.blocked", jobId),
                        issuedAt: new Date().toISOString(),
                        expiresAt: new Date(Date.now() + 15000).toISOString(),
                        execution: { requestedDeadlineAt: Date.now() + 60000 },
                        operation: { kind: "service.restart", serviceId: "motis" },
                      }),
                    });
                    expect(blocked.status).toBe(409);
                    expect(await blocked.json()).toMatchObject({ error: { class: "busy" } });
                    expect(
                      (await createApiOpsClient().execute({ kind: "docker.status" })).execution,
                    ).toBe("sync");
                    const childControl = await import(
                      "../../../../ops-agent/src/configuration-handoff-control"
                    );
                    const args = host.calls.find((args) => args[0] === "run")!;
                    const env = (name: string) =>
                      args.find((value) => value.startsWith(`${name}=`))!.slice(name.length + 1);
                    await expect(
                      childControl.openConfigurationHandoffChild({
                        rootDir: host.root,
                        handoffId: owner.plan.handoff!.handoffId,
                        assertion: env("OPENMAPX_CONTROL_DELEGATION"),
                        execution: {
                          ...JSON.parse(env("OPENMAPX_CONTROL_EXECUTION")),
                          executionId: randomUUID(),
                        },
                      }),
                    ).rejects.toThrow("Original configuration helper spawn required");
                    const child = await childControl.openConfigurationHandoffChild({
                      rootDir: host.root,
                      handoffId: owner.plan.handoff!.handoffId,
                      assertion: env("OPENMAPX_CONTROL_DELEGATION"),
                      execution: JSON.parse(env("OPENMAPX_CONTROL_EXECUTION")),
                    });
                    try {
                      await childControl.waitForConfigurationHandoffPreparation(
                        child,
                        AbortSignal.timeout(2000),
                      );
                      expect(
                        host.calls.filter((args) => args[0] === "compose" && args.includes("up")),
                      ).toHaveLength(0);
                    } finally {
                      childControl.closeConfigurationHandoffChild(child);
                    }
                    return;
                  }
                  const abandon =
                    await prospective.prepareConfigurationMaintenanceAbandon(candidate);
                  await prospective.decideConfigurationMaintenance(abandon);
                  const unused = await prospective.inspectConfigurationMaintenance({
                    maintenanceId: receipt.binding.maintenanceId,
                    candidateId: candidate.candidateId,
                  });
                  const settled = await prospective.settleConfigurationMaintenance({
                    kind: "configurationMaintenance.settle",
                    maintenanceId: receipt.binding.maintenanceId,
                    candidateId: candidate.candidateId,
                    prepareOperationKey: unused.prepare.operationKey,
                    prepareFingerprint: unused.prepare.operationFingerprint,
                    planDigest: unused.planDigest,
                    decisionId: abandon.decisionId,
                    expectedSequence: unused.sequence,
                    evidenceDigest: configurationMaintenanceSettleRequestDigest(unused),
                  });
                  expect(settled.state).toBe("settled");
                  expect(dm.settlePosts).toBe(1);
                  await dm.assertDataAdmission();
                  await prospective.discardUnusedPreparedProspectiveConfiguration(candidate);
                }
                expect(dm.preparePosts).toBe(version === "old" ? 0 : 1);
                expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                  host.initial.revisionId,
                );
                const [desired] = await state.fixture.db
                  .select()
                  .from(schema.systemSettings)
                  .where(eq(schema.systemSettings.key, "platformConfiguration"));
                expect(desired).toBeUndefined();
                const [retained] = await state.fixture.db
                  .select()
                  .from(schema.platformConfigurationPreview)
                  .where(eq(schema.platformConfigurationPreview.id, preview.previewId));
                expect(retained?.consumedAt).toBeNull();
              },
            ),
          );
        } finally {
          await dm.close();
          await app.close();
          closeControlInstallation(installation);
          state.services = [];
          vi.unstubAllEnvs();
          rmSync(host.cleanupRoot, { recursive: true, force: true });
        }
      },
      120000,
    );
  },
);
