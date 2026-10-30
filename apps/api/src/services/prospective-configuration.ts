import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type IntegrationApplyReceipt,
  integrationApplyReceiptSchema,
} from "@openmapx/core/api-contracts";
import { controlChildOperationKey } from "@openmapx/core/build-artifacts";
import {
  acquireTrustedConfigurationQueueLock,
  type ConfigurationHardlinksPreview,
  type ConfigurationMaintenanceDecision,
  type ConfigurationMaintenanceIdentity,
  type ConfigurationMaintenanceReceipt,
  type ConfigurationMaintenanceSettle,
  type ConfigurationSourcesInspection,
  type CoordinatorMode,
  canonicalJson,
  configurationApplyResultSchema,
  configurationHardlinksPreviewSchema,
  configurationMaintenanceDecisionSchema,
  configurationMaintenanceIdentitySchema,
  configurationMaintenancePrepareSchema,
  configurationMaintenanceReceiptSchema,
  configurationMaintenanceSettleRequestDigest,
  configurationMaintenanceSettleSchema,
  coordinatorModeSchema,
  createControlRootOperationKey,
  encodePreparedConfigurationRecord,
  inspectPreparedConfigurationRecord,
  type OpsOperation,
  opsOperationFingerprint,
  opsOperationSchema,
  type PreparedConfigurationRecord,
  parseControlRootOperationKey,
  protectedConfigurationServiceIdSchema,
  readOpsTokenFile,
  sealTrustedConfigurationSnapshot,
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import { integrationApplicationReceipt } from "../db/schema";
import { resolveIntegrationConfigWithSourcesStrict } from "../integration-config";
import { getIntegration, inspectIntegrationRuntime } from "../integration-host";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  deliverCoordinatorPullSubmission,
  ensureAdminJobReceiptDelivery,
  executeAdminJobOperation,
  prepareAdminJobOperationRoot,
  readProjection,
  reserveCoordinatorPullSubmission,
  resumeAdminJobObservation,
} from "./admin-job-ops";
import {
  type ApiJobChildAttempt,
  issueApiJobChildAssertion,
  prepareApiJobChildAttempt,
  prepareApiJobRoot,
} from "./admin-job-parent";
import {
  hasPendingReceiptDelivery,
  hasUnsettledManagedOperation,
  jobOwnership,
} from "./admin-job-state";
import {
  administrativeConfigurationFileObservations,
  closeAdministrativeConfigurationRead,
  openAdministrativeConfigurationRead,
  withAdministrativeConfigurationReadScope,
} from "./administrative-configuration-context";
import {
  type AdministrativeConfigurationReadContext,
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  assertAdministrativeConfigurationRead,
  ConfigurationWriteCommitUnknown,
  ConfigurationWriteRolledBack,
  type ConfigurationWriteTransaction,
  currentAdministrativeConfigurationWriter,
  withAdministrativeConfigurationRead,
  withConfigurationWriteTransaction,
} from "./administrative-configuration-writer";
import {
  configurationMaintenanceDecisionCheckpointSchema as abandonCheckpointSchema,
  assertConfigurationSavedRows,
  type ConfigurationSavedRow,
  configurationMaintenanceDbDecisionDigest,
  configurationMaintenanceDecisionCheckpointSchema,
  configurationMaintenanceRollbackCheckpointSchema,
  configurationSavedRowSchema,
} from "./configuration-maintenance-decision";
import { configurationMaintenanceSettleCheckpointSchema } from "./configuration-maintenance-settle-records";
import { prepareOwnedConfigurationMaintenanceStep } from "./configuration-maintenance-step";
import {
  completedCoordinatorMaintenance,
  completedCoordinatorMaintenanceSchema,
} from "./configuration-maintenance-step-records";
import { assertLegacyIntegrationImportOverlay } from "./configuration-migration/legacy-integration-import-intent";
import {
  ConfigurationSourceOwned,
  IntegrationConfigurationConflict,
  integrationOwnershipSnapshot,
  projectFieldOwnership,
} from "./configuration-ownership-view";
import {
  assertCoordinatorLifecycleIntent,
  assertRetainedCoordinatorLifecycleProvenance,
  type CoordinatorLifecycleIntent,
  closeUnissuedCoordinatorPull,
  coordinatorLifecycleOperationKey,
} from "./coordinator-lifecycle";
import {
  assertIntegrationBindingOverlay,
  assertSavedIntegrationBinding,
} from "./integration-binding-participant";
import { capturedBindingState } from "./integration-binding-state";
import { integrationConfigRevision } from "./integration-runtime-evidence";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import {
  assertPlatformConfigurationOverlay,
  assertPlatformConfigurationSource,
  retainedPlatformConfigurationIntent,
  retainedPlatformConfigurationSource,
} from "./platform-configuration-participant";
import { encrypt } from "./secrets";
import { resolveServiceConfigWithSourcesStrict } from "./service-config-resolver";
import { getServiceRegistry, resolveRequiresForIntegration } from "./service-registry";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
  type TrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";
import {
  consumePublishedTrustedConfiguration,
  findPreparedTrustedConfigurationCandidate,
  publishSnapshot,
  REJECTED,
  readPreparedTrustedConfigurationCandidate,
  retainPreparedTrustedConfigurationCandidate,
  SNAPSHOT_MODE,
  syncDirectory,
  validateDirectory,
  withPublicationLock,
} from "./trusted-config-publication-store";

export type BoundedConfigValue =
  TrustedConfigurationPayload["serviceConfigs"][number]["values"][string];
export type PlatformField<T> = coreServices.PlatformField<T>;
export type PlatformConfigurationPatch = Omit<coreServices.PlatformConfiguration, "version">;
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((key) => !key.includes("..") && !["__proto__", "prototype", "constructor"].includes(key));
const config = trustedConfigurationPayloadSchema.shape.serviceConfigs.element.shape.values;
const ordinary = { set: config, unset: z.array(key).max(128) };
const secretSet = {
  key,
  action: z.literal("set"),
  value: z
    .string()
    .max(65536)
    .refine((value) => value.isWellFormed()),
};
const secretDelete = { key, action: z.literal("delete") };
const overlaySchema = z.strictObject({
  purpose: z.enum([
    "render",
    "selection",
    "service-config",
    "service-secret",
    "integration-config",
    "integration-secret",
    "integration-binding",
    "migration",
    "platform",
    "transit-credentials",
  ]),
  coordinatorMode: coordinatorModeSchema,
  changes: z
    .array(
      z.union([
        z.strictObject({ kind: z.literal("service-config"), serviceId: id, ...ordinary }),
        z.strictObject({ kind: z.literal("integration-config"), integrationId: id, ...ordinary }),
        z.strictObject({ kind: z.literal("service-secret"), serviceId: id, ...secretSet }),
        z.strictObject({ kind: z.literal("service-secret"), serviceId: id, ...secretDelete }),
        z.strictObject({
          kind: z.literal("integration-secret"),
          integrationId: id,
          ...secretSet,
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        }),
        z.strictObject({
          kind: z.literal("integration-secret"),
          integrationId: id,
          ...secretDelete,
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        }),
        z.strictObject({
          kind: z.literal("integration-binding"),
          integrationId: id,
          capability: z.string().min(1).max(128),
          serviceId: id.nullable(),
          expectedServiceId: id.nullable(),
          expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
          nextVersion: z.uuid(),
          desiredRevision: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        z.strictObject({ kind: z.literal("selection"), selectedRoots: z.array(id).max(256) }),
        z.strictObject({
          kind: z.literal("platform"),
          patch: coreServices.platformConfigurationSchema.omit({ version: true }),
        }),
      ]),
    )
    .max(512),
});
type Overlay = z.infer<typeof overlaySchema>;
export type ProspectiveConfigurationOverlay = Omit<Overlay, "changes"> & {
  changes: (
    | Exclude<Overlay["changes"][number], { kind: "platform" }>
    | { kind: "platform"; patch: PlatformConfigurationPatch }
  )[];
};
declare const candidateBrand: unique symbol;
export interface ValidatedConfigurationCandidate {
  readonly [candidateBrand]: true;
  readonly candidateId: string;
  readonly operationKey: string;
  readonly expectedCurrentRevisionId: string | null;
  readonly revisionId: string;
  readonly sourceFingerprint: string;
  readonly sealedBytes: number;
  readonly affectedServiceIds: readonly string[];
}
export type ProspectiveConfigurationReceipt = {
  candidateId: string;
  revisionId: string;
  saved: "unchanged" | "committed" | "conflict" | "unknown";
  application: TrustedConfigurationApplyOutcome;
};
interface CandidateState {
  writer: AdministrativeConfigurationWriter;
  overlay: Overlay;
  payload: TrustedConfigurationPayload;
  sealed: ReturnType<typeof sealTrustedConfigurationSnapshot>;
  record: PreparedConfigurationRecord;
  publisher: { directory: string; token: string; ownerUid: number; ownerGid: number };
  source: ConfigurationSourcesInspection | null;
  preview?: ConfigurationHardlinksPreview;
  rows: Pick<
    AdministrativeConfigurationReadContext,
    | "services"
    | "integrations"
    | "env"
    | "serviceRows"
    | "integrationRows"
    | "serviceSecretRows"
    | "integrationSecretRows"
    | "bindingRows"
    | "bindingRevisionRows"
    | "integrationBindingSnapshot"
  > | null;
  sourceRows: Pick<
    AdministrativeConfigurationReadContext,
    "serviceRows" | "integrationRows" | "serviceSecretRows" | "integrationSecretRows"
  > | null;
  persisted: boolean;
  integrationReloadSnapshot: NonNullable<
    AdministrativeConfigurationReadContext["integrationReloadSnapshot"]
  > | null;
}
const candidates = new WeakMap<ValidatedConfigurationCandidate, CandidateState>();
const recoveredCommittedCandidates = new WeakSet<ValidatedConfigurationCandidate>();
const recoveredPreRootCandidates = new WeakSet<ValidatedConfigurationCandidate>();
const rejectedUnissuedCandidates = new WeakSet<ValidatedConfigurationCandidate>();
const discardedUnusedCandidates = new WeakMap<
  ValidatedConfigurationCandidate,
  ReturnType<typeof configurationMaintenanceReceiptSchema.parse>
>();
/** A known comparison/refusal produced here selects an inert intent failure.
 * External exceptions and observer aborts never mint this local evidence. */
function rejectUnissuedCandidate(
  candidate: ValidatedConfigurationCandidate,
  message: string,
): never {
  rejectedUnissuedCandidates.add(candidate);
  throw Error(message);
}
const candidateStages = new WeakMap<
  ValidatedConfigurationCandidate,
  | "preflight"
  | "prepared"
  | "recovered_pre_save"
  | "recovered_unissued"
  | "save_attempted"
  | "rolled_back"
  | "committed"
  | "never_prepared"
  | "unissued"
  | "unused"
  | "discarded"
  | "retired"
>();
export function validatedConfigurationCandidateState(
  candidate: ValidatedConfigurationCandidate,
): CandidateState {
  const state = candidates.get(candidate);
  if (!state || currentAdministrativeConfigurationWriter() !== state.writer)
    throw Error("Configuration candidate unavailable");
  administrativeConfigurationState(state.writer);
  return state;
}
/** Verify against the actual nominal candidate state, then the issuer's
 * unchanged source/row checks. No caller metadata stands in for this join. */
async function verifyConfigurationCommitParticipant(
  candidate: ValidatedConfigurationCandidate,
  writer: AdministrativeConfigurationWriter,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(writer);
  if (state.writer !== writer) throw Error("Configuration candidate unavailable");
  if (state.record.privateCoordinatorLifecycle) {
    const [actual] = await owner.connection
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(owner.job.jobId, owner.job.execution));
    if (!actual) throw Error("Actual coordinator job unavailable");
    assertRetainedCoordinatorLifecycleProvenance(actual, state.record);
  }
  if (state.overlay.purpose === "migration")
    assertLegacyIntegrationImportOverlay(writer, state.overlay);
  if (state.overlay.purpose === "integration-binding")
    assertIntegrationBindingOverlay(writer, state.overlay);
  if (state.overlay.purpose === "platform") {
    if (recoveredCommittedCandidates.has(candidate)) {
      const { assertSavedPlatformConfiguration } = await import(
        "./platform-configuration-recovery"
      );
      if (!state.record.privatePlatformIntent) throw Error("Original platform candidate required");
      await assertSavedPlatformConfiguration(
        {
          actorId: writer.actorId,
          jobId: owner.job.jobId,
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
          intent: state.record.privatePlatformIntent,
          checkpoint: owner.job.checkpointResult,
        },
        owner.connection,
      );
      return;
    }
    assertPlatformConfigurationOverlay(writer, state.overlay);
    const intent = retainedPlatformConfigurationIntent(writer);
    if (
      state.writer !== writer ||
      !state.record.maintenanceId ||
      state.record.apiFollowUp !== "platform-apply" ||
      state.source?.sourceRevision !== intent.sourceRevision ||
      canonicalJson(state.payload.platform) !== canonicalJson(intent.configuration) ||
      canonicalJson(state.record.privatePlatformIntent) !== canonicalJson(intent)
    )
      throw Error("Original platform candidate required");
  }
  await owner.participant?.verify(candidate, writer);
}
export function assertCommittedConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): void {
  validatedConfigurationCandidateState(candidate);
  if (candidateStages.get(candidate) !== "committed")
    throw Error("Committed configuration candidate required");
}
export function assertKnownRolledBackConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): void {
  const state = validatedConfigurationCandidateState(candidate);
  if (state.persisted || candidateStages.get(candidate) !== "rolled_back")
    throw Error("Actual original rolled-back candidate required");
}
export function assertUnadmittedConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): void {
  const state = validatedConfigurationCandidateState(candidate);
  const stage = candidateStages.get(candidate);
  if (
    !["preflight", "prepared", "rolled_back", "never_prepared", "unissued", "unused"].includes(
      stage ?? "",
    ) ||
    (state.record.maintenanceId &&
      !["preflight", "never_prepared", "unissued", "unused"].includes(stage ?? ""))
  )
    throw Error("Known unadmitted configuration candidate required");
}
/** Before any maintenance admission attempt, the original locked API row is
 * the producer of nonissuance. A settled ordinary prerequisite is observed at
 * its original address; it is neither undone nor permission to acquire a root.
 * Missing/unknown helper delivery or any root/save attempt keeps the fence. */
async function discardUnissuedMaintenanceCandidate(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    record = state.record;
  if (
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    !["prepared", "recovered_unissued"].includes(candidateStages.get(candidate) ?? "") ||
    state.persisted
  )
    throw new JobObservationPending("recovery_required");
  const fixed = record.coordinatorPrerequisite,
    projection = readProjection(owner.job.checkpointResult);
  if (fixed && projection.operations[fixed.root.operationKey])
    await executeAdminJobOperation(
      owner.job,
      fixed.operation,
      "configuration-maintenance.coordinator",
      { operationKey: fixed.stepAddress, preparedRoot: fixed.root },
    );
  const originalPull =
    record.privateCoordinatorLifecycle?.action === "update"
      ? record.privateCoordinatorLifecycle.pull
      : undefined;
  if (originalPull) {
    const entry = readProjection(owner.job.checkpointResult).operations[originalPull.operationKey];
    if (!entry) throw new JobObservationPending("recovery_required");
    if (entry.phase === "prepared")
      await closeUnissuedCoordinatorPull(owner.job, candidate.candidateId, record.operationKey);
    else if (entry.phase !== "unissued") {
      const { observeRetainedAdminJobOperation } = await import("./admin-job-ops"),
        { ApiOpsError } = await import("./ops-client");
      try {
        await observeRetainedAdminJobOperation(owner.job, originalPull.operationKey);
      } catch (error) {
        if (!(error instanceof ApiOpsError)) throw error;
      }
    }
  }
  let checkpoint: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({
          result: schema.adminJob.result,
          payload: schema.adminJob.payload,
          type: schema.adminJob.type,
        })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      actual = readProjection(result),
      helper = fixed && actual.operations[fixed.root.operationKey];
    if (
      !row ||
      row.type !== owner.job.jobType ||
      canonicalJson(row.payload) !== canonicalJson(owner.job.payload)
    )
      throw new JobObservationPending("invalid_identity");
    const lifecycle = record.privateCoordinatorLifecycle,
      prefix =
        lifecycle?.action === "update" && result
          ? await (await import("./service-update-batch")).completedServiceUpdatePrefix(
              owner.job.jobId,
              row.payload,
              result,
              lifecycle.originalOrdinal,
            )
          : { operationKeys: new Set<string>(), revisionId: candidate.expectedCurrentRevisionId };
    if (prefix.revisionId !== candidate.expectedCurrentRevisionId)
      throw new JobObservationPending("invalid_identity");
    if (
      !result ||
      retained?.candidateId !== candidate.candidateId ||
      retained.operationKey !== candidate.operationKey ||
      retained.revisionId !== candidate.revisionId ||
      retained.sealedOperationKey !== record.operationKey ||
      retained.maintenanceId !== record.maintenanceId ||
      retained.prepareOperationKey !== record.prepareOperationKey ||
      retained.phase !== "prepared" ||
      retained.rowVersions !== undefined ||
      result._configurationMaintenance !== undefined ||
      result._configurationMaintenanceDecision !== undefined ||
      result._configurationMaintenanceRollback !== undefined ||
      actual.operations[record.prepareOperationKey!] ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result) ||
      (helper &&
        (canonicalJson(helper.operation) !== canonicalJson(fixed!.operation) ||
          helper.receiptDelivery?.state !== "confirmed" ||
          helper.receiptDelivery.terminalReceipt.state !== "succeeded")) ||
      Object.values(actual.operations).some(
        (entry) =>
          entry.operationKey !== fixed?.root.operationKey &&
          !prefix.operationKeys.has(entry.operationKey) &&
          entry.operationKey !==
            (record.privateCoordinatorLifecycle?.action === "update"
              ? record.privateCoordinatorLifecycle.pull.operationKey
              : undefined),
      )
    )
      throw new JobObservationPending("recovery_required");
    checkpoint = {
      ...result,
      _configurationCandidate: { ...retained, phase: "discarding_unissued" },
    };
    const saved = await tx
      .update(schema.adminJob)
      .set({ result: checkpoint })
      .where(jobOwnership(owner.job.jobId, owner.job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (!checkpoint) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = checkpoint;
  candidateStages.set(candidate, "unissued");
  await discardUnadmittedTrustedConfigurationCandidate(candidate);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(checkpoint._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
  });
  candidateStages.set(candidate, "discarded");
}
/** Final API publication of this canceled, conclusively UNISSUED intent.
 * The private nominal stage and locked original row/child delivery prove no
 * maintenance root/save exists. A cancel marker alone supplies none of that. */
async function completeUnissuedConfigurationCancellation(
  candidate: ValidatedConfigurationCandidate,
): Promise<Record<string, unknown>> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    record = state.record;
  if (
    candidateStages.get(candidate) !== "discarded" ||
    state.persisted ||
    !record.maintenanceId ||
    !record.prepareOperationKey
  )
    throw new JobObservationPending("recovery_required");
  let committed: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({
          result: schema.adminJob.result,
          payload: schema.adminJob.payload,
          type: schema.adminJob.type,
        })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      projection = readProjection(result),
      fixed = record.coordinatorPrerequisite,
      helper = fixed && projection.operations[fixed.root.operationKey];
    if (
      !row ||
      row.type !== owner.job.jobType ||
      canonicalJson(row.payload) !== canonicalJson(owner.job.payload)
    )
      throw new JobObservationPending("invalid_identity");
    const lifecycle = record.privateCoordinatorLifecycle,
      prefix =
        lifecycle?.action === "update" && result
          ? await (await import("./service-update-batch")).completedServiceUpdatePrefix(
              owner.job.jobId,
              row.payload,
              result,
              lifecycle.originalOrdinal,
            )
          : { operationKeys: new Set<string>(), revisionId: candidate.expectedCurrentRevisionId };
    if (prefix.revisionId !== candidate.expectedCurrentRevisionId)
      throw new JobObservationPending("invalid_identity");
    if (
      !result ||
      typeof result._cancelRequestedAt !== "string" ||
      !Number.isFinite(Date.parse(result._cancelRequestedAt)) ||
      retained?.candidateId !== candidate.candidateId ||
      retained.operationKey !== candidate.operationKey ||
      retained.sealedOperationKey !== record.operationKey ||
      retained.revisionId !== candidate.revisionId ||
      retained.maintenanceId !== record.maintenanceId ||
      retained.prepareOperationKey !== record.prepareOperationKey ||
      retained.phase !== "discarded" ||
      retained.rowVersions !== undefined ||
      result._configurationMaintenance !== undefined ||
      result._configurationMaintenanceDecision !== undefined ||
      result._configurationMaintenanceRollback !== undefined ||
      projection.operations[record.prepareOperationKey!] ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result) ||
      (helper &&
        (helper.receiptDelivery?.state !== "confirmed" ||
          helper.receiptDelivery.terminalReceipt.state !== "succeeded" ||
          canonicalJson(helper.operation) !== canonicalJson(fixed!.operation))) ||
      Object.values(projection.operations).some(
        (entry) =>
          entry.operationKey !== fixed?.root.operationKey &&
          !prefix.operationKeys.has(entry.operationKey) &&
          entry.operationKey !==
            (record.privateCoordinatorLifecycle?.action === "update"
              ? record.privateCoordinatorLifecycle.pull.operationKey
              : undefined),
      )
    )
      throw new JobObservationPending("recovery_required");
    const configuration: TrustedConfigurationApplyOutcome = {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
    committed = {
      ...result,
      configuration,
      _configurationOutcomes: {
        ...(result._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: configuration,
      },
    };
    delete committed.observation;
    const saved = await tx
      .update(schema.adminJob)
      .set({ status: "canceled", finishedAt: new Date(), result: committed })
      .where(jobOwnership(owner.job.jobId, owner.job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (!committed) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = committed;
  return { configuration: committed.configuration };
}
/** Discard only this original inert candidate after the fixed host proves its
 * NoGuard closure and delivers the original canonical failure. Inspection is
 * performed here; a portable receipt/boolean supplied by a caller is useless. */
export async function discardNeverPreparedProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    stage = candidateStages.get(candidate);
  if (
    !state.record.maintenanceId ||
    !state.record.prepareOperationKey ||
    !["prepared", "recovered_pre_save", "never_prepared"].includes(stage ?? "")
  )
    throw Error("Original inert maintenance candidate required");
  const { inspectConfigurationMaintenance } = await configurationMaintenanceProtocol,
    closed = await inspectConfigurationMaintenance({
      maintenanceId: state.record.maintenanceId,
      candidateId: candidate.candidateId,
    });
  if (
    closed.state !== "settled" ||
    closed.dmFence !== null ||
    closed.decision !== null ||
    closed.generation !== "not_started" ||
    closed.appliedRevisionId !== null ||
    closed.followUp !== "not_started"
  )
    throw Error("Conclusive original NoGuard closure required");
  let checkpoint: Record<string, unknown> | undefined;
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx) => {
      // The same owned row lock waits out any earlier save/checkpoint transaction.
      const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update");
      const result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined,
        maintenance = result?._configurationMaintenance as Record<string, unknown> | undefined,
        inspection = maintenance?.inspection as Record<string, unknown> | undefined,
        projected = readProjection(result).operations[state.record.prepareOperationKey!];
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.operationKey !== candidate.operationKey ||
        retained.revisionId !== candidate.revisionId ||
        retained.sealedOperationKey !== state.record.operationKey ||
        retained.maintenanceId !== state.record.maintenanceId ||
        retained.prepareOperationKey !== state.record.prepareOperationKey ||
        !["prepared", "discarding_without_guard"].includes(String(retained.phase)) ||
        retained.rowVersions !== undefined ||
        maintenance?.decision !== undefined ||
        result._configurationDecision !== undefined ||
        inspection?.state !== "complete" ||
        canonicalJson(inspection.receipt) !== canonicalJson(closed) ||
        !projected?.terminal ||
        projected.receiptDelivery?.state !== "confirmed" ||
        projected.kind !== "configurationMaintenance.prepare" ||
        projected.operationId !== closed.prepare.executionId ||
        projected.fingerprint !== closed.prepare.fingerprint ||
        hasPendingReceiptDelivery(result) ||
        hasUnsettledManagedOperation(result)
      )
        throw Error("Original unsaved candidate closure checkpoint required");
      checkpoint = {
        ...result,
        _configurationCandidate: { ...retained, phase: "discarding_without_guard" },
      };
      const saved = await tx
        .update(schema.adminJob)
        .set({ result: checkpoint })
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .returning({ id: schema.adminJob.id });
      if (saved.length !== 1) throw Error("Original candidate cleanup ownership changed");
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  if (!checkpoint) throw Error("Original candidate cleanup checkpoint unavailable");
  owner.job.checkpointResult = checkpoint;
  candidateStages.set(candidate, "never_prepared");
  // Pending cleanup retains the global candidate fence. Only exact bytes under
  // the real queue ownership can be removed; an I/O failure leaves it pending.
  await discardUnadmittedTrustedConfigurationCandidate(candidate);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(checkpoint._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
  });
  candidateStages.set(candidate, "discarded");
}
/** A failed prepare is not itself NoGuard evidence. Only the actual fixed
 * inspector/disjoint closure and original canonical failure above permit this
 * inert cleanup and truthful failed configuration result. */
async function completeNeverPreparedConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<TrustedConfigurationApplyOutcome> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    projected =
      state.record.prepareOperationKey &&
      readProjection(owner.job.checkpointResult).operations[state.record.prepareOperationKey],
    terminal =
      projected && projected.receiptDelivery?.state === "confirmed"
        ? projected.receiptDelivery.terminalReceipt
        : undefined;
  if (
    !projected ||
    projected.kind !== "configurationMaintenance.prepare" ||
    !projected.terminal ||
    !terminal ||
    !["failed", "timed_out"].includes(terminal.state)
  )
    throw new JobObservationPending("recovery_required");
  try {
    await discardNeverPreparedProspectiveConfiguration(candidate);
  } catch {
    throw new JobObservationPending("recovery_required");
  }
  const retained = owner.job.checkpointResult?._configurationMaintenance as Record<string, unknown>,
    inspection = retained.inspection as { state?: string; receipt?: unknown },
    closed = configurationMaintenanceReceiptSchema.parse(inspection.receipt);
  if (
    inspection.state !== "complete" ||
    closed.state !== "settled" ||
    closed.dmFence !== null ||
    closed.decision !== null ||
    closed.binding.candidateId !== candidate.candidateId ||
    closed.prepare.operationKey !== state.record.prepareOperationKey
  )
    throw new JobObservationPending("recovery_required");
  const configuration: TrustedConfigurationApplyOutcome = {
    outcome: "not_committed",
    reason: terminal.errorClass === "busy" ? "busy" : "failed",
    cleanupFailed: false,
    publisherCleanupFailed: false,
    registryUpdateFailed: false,
  };
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationMaintenance: { ...retained, phase: "settled", receipt: closed },
    configuration,
    _configurationOutcomes: {
      ...(owner.job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
      [candidate.operationKey]: configuration,
    },
  });
  return configuration;
}
/** A PREPARED reservation is discarded only through its actual unused final,
 * both-role settled guard/root and original delivered API control sources.
 * This is disjoint from NeverPrepared, and accepts no receipt/boolean input. */
export async function discardUnusedPreparedProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer);
  if (
    !state.record.maintenanceId ||
    !state.record.prepareOperationKey ||
    !["prepared", "recovered_pre_save", "rolled_back", "unused", "discarded"].includes(
      candidateStages.get(candidate) ?? "",
    )
  )
    throw Error("Original unsaved prepared candidate required");
  const maintenance = await configurationMaintenanceProtocol,
    closed = await maintenance.inspectConfigurationMaintenance({
      maintenanceId: state.record.maintenanceId,
      candidateId: candidate.candidateId,
    });
  if (
    closed.state !== "settled" ||
    closed.dmFence?.state !== "settled" ||
    closed.decision?.decision !== "abandon" ||
    closed.generation !== "not_started" ||
    closed.appliedRevisionId !== null ||
    closed.followUp !== "not_started" ||
    closed.prepare.operationKey !== state.record.prepareOperationKey ||
    closed.binding.applyOperationKey !== state.record.operationKey
  )
    throw Error("Actual original prepared-unused closure required");
  let committed: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
      decision = configurationMaintenanceDecisionCheckpointSchema.parse(
        result?._configurationMaintenanceDecision,
      ),
      settle = configurationMaintenanceSettleCheckpointSchema.parse(
        result?._configurationMaintenanceSettle,
      ),
      projection = readProjection(result),
      delivered = projection.operations[settle.delivery.root.operationKey]?.receiptDelivery,
      canonical =
        delivered?.terminalReceipt.state === "succeeded"
          ? configurationMaintenanceReceiptSchema.parse(delivered.terminalReceipt.result)
          : null;
    if (
      !result ||
      retained?.candidateId !== candidate.candidateId ||
      retained.operationKey !== candidate.operationKey ||
      retained.revisionId !== candidate.revisionId ||
      retained.sealedOperationKey !== state.record.operationKey ||
      retained.maintenanceId !== state.record.maintenanceId ||
      retained.prepareOperationKey !== state.record.prepareOperationKey ||
      !["prepared", "rolled_back", "discarding_unused", "discarded"].includes(
        String(retained.phase),
      ) ||
      retained.rowVersions !== undefined ||
      remote?.phase !== "settled" ||
      decision.operation.decision !== "abandon" ||
      decision.operation.decisionId !== closed.decision?.decisionId ||
      decision.rowVersions.length ||
      decision.attempt !== "attempted" ||
      settle.attempt !== "attempted" ||
      settle.operation.candidateId !== candidate.candidateId ||
      settle.operation.maintenanceId !== state.record.maintenanceId ||
      settle.operation.decisionId !== decision.operation.decisionId ||
      delivered?.state !== "confirmed" ||
      !canonical ||
      canonicalJson(canonical) !== canonicalJson(remote.receipt) ||
      canonicalJson({ ...closed, preflight: canonical.preflight }) !== canonicalJson(canonical) ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result)
    )
      throw Error("Original delivered unused candidate checkpoint required");
    committed = { ...result, _configurationCandidate: { ...retained, phase: "discarding_unused" } };
    const saved = await tx
      .update(schema.adminJob)
      .set({ result: committed })
      .where(jobOwnership(owner.job.jobId, owner.job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw Error("Original unused cleanup ownership changed");
  });
  if (!committed) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = committed;
  candidateStages.set(candidate, "unused");
  await discardUnadmittedTrustedConfigurationCandidate(candidate);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(committed._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
  });
  candidateStages.set(candidate, "discarded");
  freeze(closed);
  discardedUnusedCandidates.set(candidate, closed);
}
/** Actual prepared-unused cancellation completion. Only the fixed discarded
 * unused producer above mints this private source after full original
 * final/SQL/mirror/ACK/release/API-copy verification and exact file cleanup. */
async function completeUnusedConfigurationCancellation(
  candidate: ValidatedConfigurationCandidate,
): Promise<Record<string, unknown>> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    record = state.record,
    closed = discardedUnusedCandidates.get(candidate);
  if (
    !closed ||
    candidateStages.get(candidate) !== "discarded" ||
    state.persisted ||
    !record.maintenanceId ||
    !record.prepareOperationKey
  )
    throw new JobObservationPending("recovery_required");
  let committed: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
      decision = configurationMaintenanceDecisionCheckpointSchema.parse(
        result?._configurationMaintenanceDecision,
      ),
      settle = configurationMaintenanceSettleCheckpointSchema.parse(
        result?._configurationMaintenanceSettle,
      ),
      projection = readProjection(result),
      delivered = projection.operations[settle.delivery.root.operationKey]?.receiptDelivery,
      canonical =
        delivered?.terminalReceipt.state === "succeeded"
          ? configurationMaintenanceReceiptSchema.parse(delivered.terminalReceipt.result)
          : null;
    if (
      !result ||
      typeof result._cancelRequestedAt !== "string" ||
      !Number.isFinite(Date.parse(result._cancelRequestedAt)) ||
      retained?.candidateId !== candidate.candidateId ||
      retained.operationKey !== candidate.operationKey ||
      retained.revisionId !== candidate.revisionId ||
      retained.sealedOperationKey !== record.operationKey ||
      retained.maintenanceId !== record.maintenanceId ||
      retained.prepareOperationKey !== record.prepareOperationKey ||
      retained.phase !== "discarded" ||
      retained.rowVersions !== undefined ||
      remote?.phase !== "settled" ||
      decision.operation.decision !== "abandon" ||
      decision.operation.decisionId !== closed.decision?.decisionId ||
      decision.rowVersions.length ||
      decision.attempt !== "attempted" ||
      settle.attempt !== "attempted" ||
      settle.operation.candidateId !== candidate.candidateId ||
      settle.operation.maintenanceId !== record.maintenanceId ||
      settle.operation.decisionId !== decision.operation.decisionId ||
      delivered?.state !== "confirmed" ||
      !canonical ||
      canonicalJson(canonical) !== canonicalJson(remote.receipt) ||
      canonicalJson({ ...closed, preflight: canonical.preflight }) !== canonicalJson(canonical) ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result)
    )
      throw new JobObservationPending("recovery_required");
    const configuration: TrustedConfigurationApplyOutcome = {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
    committed = {
      ...result,
      configuration,
      _configurationOutcomes: {
        ...(result._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: configuration,
      },
    };
    delete committed.observation;
    const saved = await tx
      .update(schema.adminJob)
      .set({ status: "canceled", finishedAt: new Date(), result: committed })
      .where(jobOwnership(owner.job.jobId, owner.job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (!committed) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = committed;
  return { configuration: committed.configuration };
}
/** Cleanup authority is the original committed candidate plus its durable,
 * fully delivered completion, never a caller-selected terminal flag. */
export async function assertSettledConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer);
  assertCommittedConfigurationCandidate(candidate);
  let contained = false;
  if (state.record.maintenanceId) {
    const maintenance = await configurationMaintenanceProtocol,
      actual = await maintenance.inspectConfigurationMaintenance({
        maintenanceId: state.record.maintenanceId,
        candidateId: candidate.candidateId,
      });
    contained =
      actual.generation === "not_committed" &&
      actual.appliedRevisionId === null &&
      actual.followUp === "contained";
    if (
      actual.state !== "settled" ||
      actual.dmFence?.state !== "settled" ||
      actual.decision?.decision !== "continue" ||
      (!contained &&
        (actual.generation !== "committed" ||
          actual.appliedRevisionId !== candidate.revisionId ||
          actual.followUp !== "complete")) ||
      actual.prepare.operationKey !== state.record.prepareOperationKey
    )
      throw Error("Actual original maintenance closure required before cleanup");
  }
  const [job] = await owner.connection
    .select({ result: schema.adminJob.result })
    .from(schema.adminJob)
    .where(jobOwnership(owner.job.jobId, owner.job.execution));
  const result = job?.result as Record<string, unknown> | undefined;
  const receipt = result?._configurationCandidate as Record<string, unknown> | undefined;
  if (
    !result ||
    receipt?.candidateId !== candidate.candidateId ||
    receipt.revisionId !== candidate.revisionId ||
    receipt.operationKey !== candidate.operationKey ||
    receipt.sealedOperationKey !== state.record.operationKey ||
    receipt.phase !== "settled" ||
    hasPendingReceiptDelivery(result) ||
    hasUnsettledManagedOperation(result)
  )
    throw Error("Configuration candidate settlement unavailable");
  const outcomes = result._configurationOutcomes as Record<string, unknown> | undefined;
  const outcome = parseTrustedConfigurationApplyOutcome(outcomes?.[candidate.operationKey]);
  if (
    contained
      ? outcome.outcome !== "not_committed" ||
        outcome.cleanupFailed ||
        outcome.publisherCleanupFailed ||
        outcome.registryUpdateFailed
      : !completeTrustedConfigurationApply(outcome) ||
        outcome.outcome !== "committed" ||
        outcome.revisionId !== candidate.revisionId
  )
    throw Error("Configuration candidate application unavailable");
  if (state.record.maintenanceId) {
    const remote = result._configurationMaintenance as Record<string, unknown> | undefined,
      settled = configurationMaintenanceReceiptSchema.parse(remote?.receipt),
      projection = readProjection(result),
      delivered = Object.values(projection.operations).find(
        (value) =>
          value.operation?.kind === "configurationMaintenance.settle" &&
          value.operation.maintenanceId === state.record.maintenanceId &&
          value.operation.candidateId === candidate.candidateId,
      );
    if (
      remote?.phase !== "settled" ||
      settled.state !== "settled" ||
      (contained
        ? settled.generation !== "not_committed" ||
          settled.appliedRevisionId !== null ||
          settled.followUp !== "contained"
        : settled.generation !== "committed" ||
          settled.appliedRevisionId !== candidate.revisionId ||
          settled.followUp !== "complete") ||
      delivered?.receiptDelivery?.state !== "confirmed" ||
      delivered.receiptDelivery.terminalReceipt.state !== "succeeded" ||
      canonicalJson(delivered.receiptDelivery.terminalReceipt.result) !== canonicalJson(settled)
    )
      throw Error("Original delivered maintenance completion required");
  }
  if (state.record.apiFollowUp === "service-apply") {
    const followUp = result.serviceCredential as Record<string, unknown> | undefined;
    if (
      followUp?.followUp !== (contained ? "contained" : "complete") ||
      followUp.revisionId !== candidate.revisionId ||
      !state.record.affectedServiceIds.includes(String(followUp.serviceId))
    )
      throw Error("Configuration follow-up unavailable");
  } else if (state.record.apiFollowUp === "integration-reload") {
    const reload = result.integrationReload as Record<string, unknown> | undefined;
    if (
      reload?.state !== "complete" ||
      reload.candidateId !== candidate.candidateId ||
      reload.revisionId !== candidate.revisionId
    )
      throw Error("Configuration reload unavailable");
  } else if (state.record.privatePlatformIntent) {
    const followUp = result.platformConfiguration as Record<string, unknown> | undefined,
      fixed = state.record.privatePlatformIntent;
    if (
      state.record.apiFollowUp !== "platform-apply" ||
      followUp?.previewFingerprint !== fixed.previewFingerprint ||
      followUp.handoffId !== fixed.handoffId ||
      followUp.revisionId !== candidate.revisionId ||
      followUp.followUp !== (contained ? "contained" : "complete")
    )
      throw Error("Original platform completion required");
  } else if (state.record.privateCoordinatorLifecycle) {
    const followUp = result.coordinatorLifecycle as Record<string, unknown> | undefined,
      fixed = state.record.privateCoordinatorLifecycle;
    if (
      state.record.apiFollowUp !== `coordinator-${fixed.action}` ||
      followUp?.action !== fixed.action ||
      followUp.revisionId !== candidate.revisionId ||
      followUp.followUp !== (contained ? "contained" : "complete")
    )
      throw Error("Original coordinator lifecycle completion required");
  } else if (state.record.apiFollowUp !== "none")
    throw Error("Configuration continuation unavailable");
}
export async function retireSettledProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  await assertSettledConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer);
  if (state.record.privatePlatformIntent) {
    const fixed = state.record.privatePlatformIntent;
    // This function has already verified the exact remote final/SQL/ACK/root
    // closure and API durable copy. A status flag cannot retire this preview.
    await withConfigurationWriteTransaction(state.writer, async (tx) => {
      const [current] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(job.jobId, job.execution))
          .for("update"),
        proof = (current?.result as Record<string, unknown> | undefined)?._configurationCandidate as
          | Record<string, unknown>
          | undefined;
      if (
        proof?.candidateId !== candidate.candidateId ||
        proof.revisionId !== candidate.revisionId ||
        proof.phase !== "settled"
      )
        throw new JobObservationPending("recovery_required");
      const [retired] = await tx
        .update(schema.platformConfigurationPreview)
        .set({
          retiredAt: sql`coalesce(${schema.platformConfigurationPreview.retiredAt},greatest(${schema.platformConfigurationPreview.consumedAt},${new Date().toISOString()}::timestamptz))`,
        })
        .where(
          and(
            eq(schema.platformConfigurationPreview.id, fixed.previewId),
            eq(schema.platformConfigurationPreview.actorId, state.writer.actorId),
            eq(schema.platformConfigurationPreview.previewFingerprint, fixed.previewFingerprint),
            eq(schema.platformConfigurationPreview.consumedByJobId, job.jobId),
          ),
        )
        .returning({ id: schema.platformConfigurationPreview.id });
      if (!retired) throw new JobObservationPending("recovery_required");
    });
  }
  const queuedCoordinator =
    !!state.record.privateCoordinatorLifecycle &&
    ((job.jobType === "service.apply" && job.payload.service === "data-manager") ||
      (job.jobType === "service.bulk" && job.payload.action === "update"));
  if (
    queuedCoordinator ||
    state.record.privatePlatformIntent ||
    (job.checkpointResult?._immediateJobId === job.jobId &&
      [
        "service.apply",
        "configuration.apply",
        "integration.config.import",
        "integration.binding.apply",
      ].includes(job.jobType ?? ""))
  ) {
    const original = job.checkpointResult;
    if (!original) throw new JobObservationPending("recovery_required");
    const provenance = state.record.privateIntegrationReload?.legacyImport,
      reload = original.integrationReload as { result?: Record<string, unknown> } | undefined,
      result = {
        configuration: original.configuration,
        ...(original.serviceCredential ? { serviceCredential: original.serviceCredential } : {}),
        ...(original.coordinatorLifecycle
          ? { coordinatorLifecycle: original.coordinatorLifecycle }
          : {}),
        ...(original.platformConfiguration
          ? { platformConfiguration: original.platformConfiguration }
          : {}),
        ...(original.integrationReload ? { integrationReload: original.integrationReload } : {}),
        ...(original.integrationBinding ? { integrationBinding: original.integrationBinding } : {}),
        ...(original.integrationApplication
          ? { integrationApplication: original.integrationApplication }
          : {}),
        ...(provenance
          ? {
              integrationImport: {
                ok: true,
                imported: provenance.changedIntegrationIds.length,
                skipped: provenance.integrationIds.filter(
                  (id) => !provenance.changedIntegrationIds.includes(id),
                ),
                ...reload?.result,
              },
            }
          : {}),
      },
      operationKey = state.record.maintenanceId
        ? configurationMaintenanceSettleCheckpointSchema.parse(
            original._configurationMaintenanceSettle,
          ).delivery.root.operationKey
        : state.record.apiFollowUp === "service-apply" && "serviceId" in state.sealed.operation
          ? createDurableOpsKey(
              "admin-job.credential.recreate",
              `${job.jobId}:${state.sealed.operation.serviceId}`,
            )
          : state.record.operationKey;
    let completedCoordinator: Record<string, unknown> = {};
    if (queuedCoordinator && state.record.privateCoordinatorLifecycle?.action === "update") {
      const settled = configurationMaintenanceSettleCheckpointSchema.parse(
        original._configurationMaintenanceSettle,
      );
      const source = original._configurationCandidate as Record<string, unknown>;
      const archived = completedCoordinatorMaintenanceSchema.parse({
        version: 1,
        originalOrdinal: state.record.privateCoordinatorLifecycle.originalOrdinal,
        candidate: {
          candidateId: source.candidateId,
          maintenanceId: source.maintenanceId,
          prepareOperationKey: source.prepareOperationKey,
          revisionId: source.revisionId,
          operationKey: source.operationKey,
          phase: source.phase,
        },
        receipt: (original._configurationMaintenance as { receipt: unknown }).receipt,
        steps: original._configurationMaintenanceSteps,
        settlementOperationKey: settled.delivery.root.operationKey,
      });
      completedCoordinator = { _completedCoordinatorMaintenance: archived };
      completedCoordinatorMaintenance({ ...original, ...completedCoordinator });
    }
    // The original producer has verified every required follow-up and actual
    // canonical receipt. Retain that completion BEFORE unlink, so death at
    // either side of file retirement needs only observation and exact cleanup.
    await job.checkpoint({
      ...original,
      ...completedCoordinator,
      _completion: { operationKey, result },
      _configurationCandidate: {
        ...(original._configurationCandidate as Record<string, unknown>),
        retirement: { version: 1, integrationIds: [...state.writer.integrationIds] },
      },
    });
  }
  try {
    await retireSettledTrustedConfigurationCandidate(candidate);
  } catch {
    const state = validatedConfigurationCandidateState(candidate),
      { job } = administrativeConfigurationState(state.writer);
    if ((job.checkpointResult?._configurationCandidate as Record<string, unknown>)?.retirement)
      throw new JobObservationPending("recovery_required");
    const outcome = {
      ...(job.checkpointResult?.configuration as Record<string, unknown>),
      publisherCleanupFailed: true,
    };
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationCandidate: {
        ...(job.checkpointResult?._configurationCandidate as Record<string, unknown>),
        phase: (job.checkpointResult?._configurationCandidate as Record<string, unknown>)
          ?.retirement
          ? "settled"
          : "unknown",
      },
      configuration: outcome,
      _configurationOutcomes: {
        ...(job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: outcome,
      },
    });
    throw new JobObservationPending("recovery_required");
  }
  candidateStages.set(candidate, "retired");
}

declare const retirementBrand: unique symbol;
export interface RetainedConfigurationRetirement {
  readonly [retirementBrand]: true;
}
const retirements = new WeakMap<
  RetainedConfigurationRetirement,
  {
    writer: AdministrativeConfigurationWriter;
    publisher: ReturnType<typeof publisherOptions>;
    checkpoint: Record<string, unknown>;
    apiJobId: string;
    actorId: string;
  }
>();
/** Only the actual locked completion verifier below creates these handles. */
export function retainedConfigurationRetirementState(handle: RetainedConfigurationRetirement) {
  const state = retirements.get(handle);
  if (!state || currentAdministrativeConfigurationWriter() !== state.writer)
    throw new JobObservationPending("recovery_required");
  administrativeConfigurationState(state.writer);
  return state;
}
const retirementSchema = z.strictObject({
  version: z.literal(1),
  integrationIds: z.array(id).max(256),
});
async function resumeCompletedConfigurationRetirement(): Promise<Record<string, unknown>> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer);
  let original: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(job.jobId, job.execution))
      .for("update");
    original = row?.result as Record<string, unknown> | undefined;
    const retained = original?._configurationCandidate as Record<string, unknown> | undefined,
      retirement = retirementSchema.parse(retained?.retirement);
    const queued =
      row?.type === job.jobType &&
      canonicalJson(row?.payload) === canonicalJson(job.payload) &&
      writer.actorId === job.jobId &&
      ((row.type === "service.apply" &&
        job.payload.service === "data-manager" &&
        Object.keys(job.payload).length === 1 &&
        writer.operationKey === coordinatorLifecycleOperationKey(job.jobId, null)) ||
        (row.type === "service.bulk" &&
          job.payload.action === "update" &&
          completedCoordinatorMaintenance(original!).receipt.apiJobId === job.jobId &&
          writer.operationKey ===
            coordinatorLifecycleOperationKey(
              job.jobId,
              completedCoordinatorMaintenance(original!).originalOrdinal,
            )));
    if (
      !original ||
      (!queued &&
        (original._immediateJobId !== job.jobId ||
          original._immediateActorId !== writer.actorId)) ||
      retained?.operationKey !== writer.operationKey ||
      retained.phase !== "settled" ||
      canonicalJson(retirement.integrationIds) !== canonicalJson(writer.integrationIds) ||
      hasPendingReceiptDelivery(original) ||
      hasUnsettledManagedOperation(original)
    )
      throw new JobObservationPending("recovery_required");
  });
  if (!original) throw new JobObservationPending("recovery_required");
  job.checkpointResult = original;
  const retained = original._configurationCandidate as Record<string, unknown>,
    completion = original._completion as
      | { operationKey?: string; result?: Record<string, unknown> }
      | undefined;
  if (
    !completion?.operationKey ||
    !completion.result ||
    canonicalJson(completion.result.configuration) !==
      canonicalJson(
        (original._configurationOutcomes as Record<string, unknown>)?.[writer.operationKey],
      )
  )
    throw new JobObservationPending("recovery_required");
  // This is the existing canonical observer, not replay of a producer/child.
  // A missing packet or the retirement marker alone never proves completion.
  await resumeAdminJobObservation(job);
  if (retained.maintenanceId) {
    const actual = await (await configurationMaintenanceProtocol).inspectConfigurationMaintenance({
        maintenanceId: String(retained.maintenanceId),
        candidateId: String(retained.candidateId),
      }),
      remote = original._configurationMaintenance as
        | { receipt?: unknown; phase?: string }
        | undefined;
    if (
      actual.state !== "settled" ||
      actual.dmFence?.state !== "settled" ||
      actual.decision?.decision !== "continue" ||
      remote?.phase !== "settled" ||
      canonicalJson({
        ...actual,
        preflight: configurationMaintenanceReceiptSchema.parse(remote.receipt).preflight,
      }) !== canonicalJson(remote.receipt)
    )
      throw new JobObservationPending("recovery_required");
  }
  const handle = Object.freeze({}) as RetainedConfigurationRetirement;
  retirements.set(handle, {
    writer,
    publisher: publisherOptions(await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "")),
    checkpoint: retained,
    apiJobId: job.jobId,
    actorId: writer.actorId,
  });
  try {
    await completeRetainedConfigurationRetirement(handle);
  } finally {
    retirements.delete(handle);
  }
  await job.checkpoint({ ...job.checkpointResult, ...completion.result });
  return completion.result;
}
/** Reload from this exact committed candidate, while its captured read scope is live. */
export async function withProspectiveConfigurationRead<T>(
  candidate: ValidatedConfigurationCandidate,
  run: (context: AdministrativeConfigurationReadContext) => Promise<T>,
): Promise<T> {
  const state = validatedConfigurationCandidateState(candidate);
  assertCommittedConfigurationCandidate(candidate);
  if (!state.rows || !state.integrationReloadSnapshot)
    throw Error("Captured candidate reload state unavailable");
  const context = openAdministrativeConfigurationRead({
    ...state.rows,
    services: state.rows.services,
    integrations: state.rows.integrations,
    env: state.rows.env,
    integrationReloadSnapshot: state.integrationReloadSnapshot,
    integrationBindingSnapshot: state.record.privateIntegrationReload?.bindings,
  });
  try {
    return await withAdministrativeConfigurationReadScope(context, () => run(context));
  } finally {
    closeAdministrativeConfigurationRead(context);
  }
}
/** The finite reload continuation. Recovery consumes the authenticated resolved
 * values, with exact registry metadata revalidation; it never reconstructs the
 * candidate from current desired rows or captures unrelated process secrets. */
async function assertCurrentIntegrationReloadSources(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    retained = state.record.privateIntegrationReload;
  if (!retained?.bindings) throw new JobObservationPending("recovery_required");
  const expectedBindings = retained.bindings;
  await withAdministrativeConfigurationRead({}, async (read) => {
    if (
      canonicalJson(retained.services) !== canonicalJson(read.services) ||
      canonicalJson(retained.integrations) !==
        canonicalJson(
          read.integrations.map((i) => ({
            id: i.id,
            directory: i.directory,
            manifest: i.manifest,
            isBuiltIn: i.isBuiltIn,
          })),
        )
    )
      throw Error("Integration source changed");
    for (const integration of read.integrations) {
      const resolved = await resolveIntegrationConfigWithSourcesStrict(
        integration.manifest,
        integration.directory,
        read,
      );
      if (
        canonicalJson(resolved) !== canonicalJson(retained.values[integration.id]) ||
        canonicalJson(capturedBindingState(read, integration.id).bindings) !==
          canonicalJson(expectedBindings[integration.id] ?? {})
      )
        throw Error("Integration source changed");
    }
  });
}
export async function reloadProspectiveIntegrations(candidate: ValidatedConfigurationCandidate) {
  await assertCurrentIntegrationReloadSources(candidate);
  const state = validatedConfigurationCandidateState(candidate);
  assertCommittedConfigurationCandidate(candidate);
  const { reloadIntegrations } = await import("../integration-host");
  if (!recoveredCommittedCandidates.has(candidate))
    return withProspectiveConfigurationRead(candidate, (read) => reloadIntegrations(read));
  const retained = state.record.privateIntegrationReload;
  if (state.record.apiFollowUp !== "integration-reload" || !retained || !retained.bindings)
    throw new JobObservationPending("recovery_required");
  return withAdministrativeConfigurationRead({}, async (read) => {
    if (
      canonicalJson(retained.services) !== canonicalJson(read.services) ||
      canonicalJson(retained.integrations) !==
        canonicalJson(
          read.integrations.map((i) => ({
            id: i.id,
            directory: i.directory,
            manifest: i.manifest,
            isBuiltIn: i.isBuiltIn,
          })),
        ) ||
      canonicalJson(Object.keys(retained.values).sort()) !==
        canonicalJson(read.integrations.map((i) => i.id).sort())
    )
      throw new JobObservationPending("recovery_required");
    const captured = openAdministrativeConfigurationRead({
      ...read,
      integrationReloadSnapshot: retained.values,
      integrationBindingSnapshot: retained.bindings,
    });
    try {
      return await withAdministrativeConfigurationReadScope(captured, () =>
        reloadIntegrations(captured),
      );
    } finally {
      closeAdministrativeConfigurationRead(captured);
    }
  });
}
/** Fixed current non-DM credential continuation, shared by fresh and restored
 * original candidates. Attempted child addresses remain lookup-only. */
export async function completeProspectiveServiceCredential(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    { job: ctx } = administrativeConfigurationState(state.writer),
    operation = state.sealed.operation;
  assertCommittedConfigurationCandidate(candidate);
  const application = parseTrustedConfigurationApplyOutcome(ctx.checkpointResult?.configuration);
  if (
    state.record.maintenanceId ||
    state.record.apiFollowUp !== "service-apply" ||
    operation.kind !== "vault.apply" ||
    operation.serviceId === "data-manager" ||
    !completeTrustedConfigurationApply(application) ||
    application.outcome !== "committed" ||
    application.revisionId !== candidate.revisionId
  )
    throw new JobObservationPending("recovery_required");
  const previous = ctx.checkpointResult?.serviceCredential as
    | { serviceId?: string; revisionId?: string; followUp?: string }
    | undefined;
  if (
    previous &&
    (previous.serviceId !== operation.serviceId ||
      previous.revisionId !== candidate.revisionId ||
      !["not_started", "unknown", "complete"].includes(previous.followUp ?? ""))
  )
    throw new JobObservationPending("recovery_required");
  if (!("serviceId" in operation)) throw Error("Credential continuation target missing");
  const serviceId = operation.serviceId,
    revisionId = application.revisionId;
  const { applyGenerationHardlinks } = await import("./configuration-hardlinks");
  if (!ctx.checkpointResult?.serviceCredential)
    await ctx.checkpoint({
      ...ctx.checkpointResult,
      serviceCredential: { serviceId, revisionId, followUp: "not_started" },
    });
  try {
    const hardlinks = await applyGenerationHardlinks({
      ctx,
      revisionId,
      operationIdentity: `${ctx.jobId}:credential`,
      coordinatorMode: "ensure-running",
      signal: ctx.signal,
    });
    const completion = {
      configuration: application,
      _configurationCandidate: {
        ...(ctx.checkpointResult?._configurationCandidate as Record<string, unknown>),
        phase: "settled",
      },
      serviceCredential: { serviceId, revisionId, followUp: "complete", hardlinks },
    };
    await ctx.checkpoint({
      ...ctx.checkpointResult,
      _completion: {
        operationKey: createDurableOpsKey(
          "admin-job.credential.recreate",
          `${ctx.jobId}:${serviceId}`,
        ),
        result: completion,
      },
    });
    await executeAdminJobOperation(
      ctx,
      { kind: "service.recreate", serviceId, expectedConfigurationRevisionId: revisionId },
      "admin-job.credential.recreate",
      { durableIdentity: serviceId },
    );
    await ctx.checkpoint({ ...ctx.checkpointResult, ...completion });
    await retireSettledProspectiveConfiguration(candidate);
  } catch (error) {
    const { ApiOpsError, OpsObservationPending } = await import("./ops-client");
    const known = error instanceof ApiOpsError || error instanceof AdminJobFailure;
    await ctx.checkpoint({
      ...ctx.checkpointResult,
      _configurationCandidate: {
        ...(ctx.checkpointResult?._configurationCandidate as Record<string, unknown>),
        phase: known ? "settled" : "unknown",
      },
      serviceCredential: { serviceId, revisionId, followUp: known ? "failed" : "unknown" },
    });
    if (error instanceof JobObservationPending || error instanceof OpsObservationPending)
      throw error;
    if (known)
      throw new AdminJobFailure("Credential follow-up did not complete", {
        configuration: { ...application, followUp: "failed" },
        serviceCredential: { serviceId, revisionId, followUp: "failed" },
      });
    throw new JobObservationPending("recovery_required");
  }
}
function retainedIntegrationIds(record: PreparedConfigurationRecord, overlay: Overlay): string[] {
  if (overlay.purpose === "migration") {
    const provenance = record.privateIntegrationReload?.legacyImport;
    if (
      !provenance ||
      record.apiFollowUp !== "integration-reload" ||
      canonicalJson(provenance.integrationIds) !==
        canonicalJson([...new Set(provenance.integrationIds)].sort()) ||
      canonicalJson(provenance.changedIntegrationIds) !==
        canonicalJson(
          overlay.changes.map((change) => {
            if (
              change.kind !== "integration-config" ||
              !provenance.integrationIds.includes(change.integrationId)
            )
              throw new JobObservationPending("recovery_required");
            return change.integrationId;
          }),
        ) ||
      new Set(provenance.changedIntegrationIds).size !== provenance.changedIntegrationIds.length
    )
      throw new JobObservationPending("recovery_required");
    return provenance.integrationIds;
  }
  if (record.privateIntegrationReload?.legacyImport)
    throw new JobObservationPending("recovery_required");
  return [
    ...new Set(
      overlay.changes.flatMap((change) =>
        "integrationId" in change ? [change.integrationId] : [],
      ),
    ),
  ].sort();
}
/** Lock-set observation only. Full private packet, job owner, saved receipts and
 * closed producer checks are repeated under the actual writer/row lock. */
export async function retainedConfigurationIntegrationIds(
  job: import("./job-runner").JobContext,
  actorId: string,
  operationKey: string,
): Promise<string[]> {
  try {
    const retained = job.checkpointResult?._configurationCandidate as
      | Record<string, unknown>
      | undefined;
    if (retained?.retirement !== undefined)
      return retirementSchema.parse(retained.retirement).integrationIds;
    if (typeof retained?.sealedOperationKey !== "string") throw Error();
    const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
      { record } = await readPreparedTrustedConfigurationCandidate(
        publisherOptions(token),
        retained.sealedOperationKey,
      );
    if (
      record.apiJobId !== job.jobId ||
      record.actorId !== actorId ||
      retained.operationKey !== operationKey ||
      record.candidateId !== retained.candidateId
    )
      throw Error();
    return retainedIntegrationIds(record, overlaySchema.parse(record.privateOverlay));
  } catch {
    throw new JobObservationPending("recovery_required");
  }
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
async function sourceFingerprint(
  context: AdministrativeConfigurationReadContext,
  token: string,
): Promise<string> {
  const integrations = [];
  for (const integration of context.integrations)
    integrations.push({
      id: integration.id,
      config: await resolveIntegrationConfigWithSourcesStrict(
        integration.manifest,
        integration.directory,
        context,
      ),
    });
  const subkey = createHmac("sha256", token).update("openmapx-prospective-source-v1").digest();
  return createHmac("sha256", subkey)
    .update(
      canonicalJson({
        services: context.services.map((service) => service.manifest),
        integrations,
        env: context.env,
        files: administrativeConfigurationFileObservations(context),
        serviceRows: context.serviceRows,
        bindingRows: context.bindingRows,
        bindingRevisionRows: context.bindingRevisionRows,
        integrationRows: context.integrationRows,
        serviceSecretRows: context.serviceSecretRows,
        integrationSecretRows: context.integrationSecretRows,
      }),
    )
    .digest("hex");
}
function publisherOptions(token: string) {
  const number = (name: string) => {
    const value = process.env[name];
    if (!value || !/^(0|[1-9][0-9]{0,9})$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw Error("Configuration candidate unavailable");
    return Number(value);
  };
  const directory = process.env.OPS_TRUSTED_CONFIG_DIR;
  if (!directory) throw Error("Configuration candidate unavailable");
  return {
    directory,
    token,
    ownerUid: number("OPS_TRUSTED_CONFIG_UID"),
    ownerGid: number("OPS_TRUSTED_CONFIG_GID"),
  };
}
/** Rehydrate the original pre-save or atomically committed candidate under its
 * newly claimed job. The row lock waits out the former transaction; its old
 * ownership CAS cannot save again. Current desired reads never rebuild the
 * candidate. Only the exact saved decision/row receipts permit continuation;
 * pre-save recovery cannot persist, preview or publish a configuration. */
async function restoreRetainedMaintenanceCandidate(): Promise<ValidatedConfigurationCandidate> {
  const writer = currentAdministrativeConfigurationWriter(),
    owner = administrativeConfigurationState(writer),
    { job } = owner;
  if (!job.execution || job.execution.version < 2 || owner.participant)
    throw new JobObservationPending("recovery_required");
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
    publisher = publisherOptions(token);
  let checkpoint: Record<string, unknown> | undefined;
  const candidate = await withConfigurationWriteTransaction(writer, async (tx, read) => {
    const [row] = await tx
        .select()
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined;
    if (
      !result ||
      !retained ||
      !["prepared", "saved", "rolled_back"].includes(String(retained.phase)) ||
      retained.operationKey !== writer.operationKey ||
      typeof retained.sealedOperationKey !== "string" ||
      (retained.phase !== "rolled_back" && result._configurationMaintenanceRollback !== undefined)
    )
      throw new JobObservationPending("recovery_required");
    const saved = retained.phase === "saved",
      rolledBack = retained.phase === "rolled_back",
      unusedDecision =
        !saved && result._configurationMaintenanceDecision !== undefined
          ? configurationMaintenanceDecisionCheckpointSchema.parse(
              result._configurationMaintenanceDecision,
            )
          : undefined,
      unusedSettlement =
        !saved && result._configurationMaintenanceSettle !== undefined
          ? configurationMaintenanceSettleCheckpointSchema.parse(
              result._configurationMaintenanceSettle,
            )
          : undefined;
    if (
      !saved &&
      (retained.rowVersions !== undefined ||
        (unusedDecision &&
          (unusedDecision.operation.decision !== "abandon" ||
            unusedDecision.rowVersions.length !== 0 ||
            unusedDecision.operation.checkpointVersion >= job.execution!.version)) ||
        (unusedSettlement && !unusedDecision))
    )
      throw new JobObservationPending("recovery_required");
    const inspected = await readPreparedTrustedConfigurationCandidate(
        publisher,
        retained.sealedOperationKey,
      ),
      record = inspected.record,
      coordinator =
        record.privateCoordinatorLifecycle && row
          ? assertRetainedCoordinatorLifecycleProvenance(row, record)
          : undefined,
      platform = record.privatePlatformIntent,
      operation = opsOperationSchema.parse(record.operation),
      overlay = overlaySchema.parse(record.privateOverlay),
      projection = readProjection(result),
      preparation = record.prepareOperationKey
        ? projection.operations[record.prepareOperationKey]
        : undefined,
      preRoot =
        !saved &&
        !preparation &&
        result._configurationMaintenance === undefined &&
        (record.privateMaintenancePreparation !== undefined ||
          record.privateCoordinatorSource !== undefined);
    const recoveryControls = [
      ...(unusedDecision?.delivery
        ? [
            {
              operation: unusedDecision.operation,
              delivery: unusedDecision.delivery,
              attempt: unusedDecision.attempt,
            },
          ]
        : []),
      ...(unusedSettlement ? [unusedSettlement] : []),
    ];
    const exactRecoveryControl = (entry: ReturnType<typeof readProjection>["operations"][string]) =>
      recoveryControls.some((source) => {
        const { operation, delivery } = source,
          attempt = entry.attempt;
        return (
          source.attempt === "attempted" &&
          entry.operationKey === delivery.root.operationKey &&
          canonicalJson(entry.operation) === canonicalJson(operation) &&
          attempt?.apiJobId === job.jobId &&
          attempt.apiOwnerVersion < job.execution!.version &&
          attempt.childOperationKey === delivery.root.operationKey &&
          attempt.childOperationFingerprint === opsOperationFingerprint(operation) &&
          attempt.requestedDeadlineAt === delivery.root.requestedDeadlineAt &&
          attempt.parentOperationKey === record.parentOperationKey &&
          attempt.parentFingerprint === record.parentFingerprint &&
          attempt.parentDeadlineAt === record.parentDeadlineAt &&
          delivery.stepAddress ===
            createDurableOpsKey(
              operation.kind === "configurationMaintenance.decide"
                ? "configuration-maintenance.decide"
                : "configuration-maintenance.settle",
              `${job.jobId}:${record.candidateId}`,
            ) &&
          canonicalJson(delivery.root.parent) ===
            canonicalJson({
              operationKey: record.parentOperationKey,
              fingerprint: record.parentFingerprint,
              deadlineAt: record.parentDeadlineAt,
            })
        );
      });
    for (const source of recoveryControls) {
      const entry = projection.operations[source.delivery.root.operationKey];
      if (
        source.delivery.stepAddress !==
          createDurableOpsKey(
            source.operation.kind === "configurationMaintenance.decide"
              ? "configuration-maintenance.decide"
              : "configuration-maintenance.settle",
            `${job.jobId}:${record.candidateId}`,
          ) ||
        canonicalJson(source.delivery.root.parent) !==
          canonicalJson({
            operationKey: record.parentOperationKey,
            fingerprint: record.parentFingerprint,
            deadlineAt: record.parentDeadlineAt,
          }) ||
        (source.attempt === "attempted"
          ? !entry || !exactRecoveryControl(entry)
          : entry !== undefined)
      )
        throw new JobObservationPending("recovery_required");
    }
    // This finite current adapter has no integration reload/participant proof
    // to reconstruct. Other recovery cases stay fenced until installed.
    if (
      (operation.kind !== "vault.apply" && operation.kind !== "stack.render") ||
      (operation.kind === "vault.apply"
        ? coordinator !== undefined ||
          operation.serviceId !== "data-manager" ||
          record.apiFollowUp !== "service-apply" ||
          !["service-secret", "transit-credentials"].includes(overlay.purpose) ||
          (overlay.purpose === "transit-credentials" &&
            (overlay.coordinatorMode !== "require-running" ||
              overlay.changes.length !== 1 ||
              overlay.changes[0]?.kind !== "service-secret" ||
              overlay.changes[0].key !== "TRANSITOUS_API_KEYS" ||
              overlay.changes[0].action !== "set")) ||
          overlay.changes.some(
            (change) => change.kind !== "service-secret" || change.serviceId !== "data-manager",
          )
        : coordinator
          ? overlay.purpose !== "render" ||
            overlay.changes.length !== 0 ||
            overlay.coordinatorMode !== "ensure-running"
          : !platform ||
            row?.type !== "platform.apply" ||
            overlay.purpose !== "platform" ||
            overlay.coordinatorMode !== "require-running" ||
            record.apiFollowUp !== "platform-apply" ||
            overlay.changes.length !== 1 ||
            overlay.changes[0]?.kind !== "platform" ||
            canonicalJson({ version: 1, ...overlay.changes[0].patch }) !==
              canonicalJson(platform.configuration) ||
            platform.sourceRevision !== record.expectedSourceRevision ||
            platform.expectedCurrentRevisionId !== operation.expectedCurrentRevisionId) ||
      !record.maintenanceId ||
      !record.prepareOperationKey ||
      record.apiJobId !== job.jobId ||
      record.actorId !== writer.actorId ||
      record.candidateId !== retained.candidateId ||
      inspected.snapshot.revisionId !== retained.revisionId ||
      record.sourceFingerprint !== retained.sourceFingerprint ||
      record.maintenanceId !== retained.maintenanceId ||
      record.prepareOperationKey !== retained.prepareOperationKey ||
      operation.candidateId !== record.candidateId ||
      operation.maintenanceId !== record.maintenanceId ||
      operation.expectedSourceRevision !== record.expectedSourceRevision ||
      operation.coordinatorMode !== overlay.coordinatorMode ||
      inspected.snapshot.operationFingerprint !== opsOperationFingerprint(operation) ||
      (!preRoot &&
        (!preparation?.attempt ||
          preparation.kind !== "configurationMaintenance.prepare" ||
          preparation.attempt.apiJobId !== job.jobId ||
          preparation.attempt.apiOwnerVersion >= job.execution!.version)) ||
      canonicalJson(result._parentExecution) !==
        canonicalJson({
          operationKey: record.parentOperationKey,
          fingerprint: record.parentFingerprint,
          deadlineAt: record.parentDeadlineAt,
        }) ||
      (!saved &&
        Object.values(projection.operations).some(
          (value) =>
            !exactRecoveryControl(value) &&
            (value.operation?.kind === "configurationMaintenance.decide" ||
              value.operation?.kind === "configurationMaintenance.settle" ||
              (value.operation &&
                "maintenanceId" in value.operation &&
                value.operation.maintenanceId === record.maintenanceId &&
                value.kind !== "configurationMaintenance.prepare")),
        ))
    )
      throw new JobObservationPending("recovery_required");
    if (rolledBack || unusedDecision) {
      // Recover only original unused controls. A rolled-back candidate still
      // requires the actual same-connection ROLLBACK acknowledgement. A retained
      // ABANDON binds the original prepared receipt and exact control attempts;
      // neither branch restores desired rows or a forward capability.
      const remote = result._configurationMaintenance as Record<string, unknown> | undefined,
        delivery = preparation?.receiptDelivery,
        prepared = configurationMaintenanceReceiptSchema.parse(delivery?.terminalReceipt.result),
        observed = configurationMaintenanceReceiptSchema.parse(remote?.receipt);
      if (rolledBack) {
        const rollback = configurationMaintenanceRollbackCheckpointSchema.parse(
          result._configurationMaintenanceRollback,
        );
        if (
          rollback.candidateId !== record.candidateId ||
          rollback.maintenanceId !== record.maintenanceId ||
          rollback.prepareOperationKey !== record.prepareOperationKey ||
          rollback.prepareFingerprint !== prepared.prepare.operationFingerprint ||
          rollback.planDigest !== prepared.planDigest ||
          rollback.checkpointVersion >= job.execution!.version
        )
          throw new JobObservationPending("recovery_required");
      }
      if (unusedDecision) {
        const { checkpointDigest, ...body } = unusedDecision.operation;
        if (
          body.candidateId !== record.candidateId ||
          body.maintenanceId !== record.maintenanceId ||
          body.prepareOperationKey !== record.prepareOperationKey ||
          body.prepareFingerprint !== prepared.prepare.operationFingerprint ||
          body.planDigest !== prepared.planDigest ||
          body.expectedSequence !== prepared.sequence ||
          checkpointDigest !== configurationMaintenanceDbDecisionDigest(body, []) ||
          (observed.decision !== null &&
            canonicalJson(observed.decision) !==
              canonicalJson({
                decisionId: body.decisionId,
                decision: body.decision,
                checkpointVersion: body.checkpointVersion,
                checkpointDigest,
              })) ||
          (unusedSettlement &&
            (unusedSettlement.operation.candidateId !== body.candidateId ||
              unusedSettlement.operation.maintenanceId !== body.maintenanceId ||
              unusedSettlement.operation.prepareOperationKey !== body.prepareOperationKey ||
              unusedSettlement.operation.prepareFingerprint !== body.prepareFingerprint ||
              unusedSettlement.operation.planDigest !== body.planDigest ||
              unusedSettlement.operation.decisionId !== body.decisionId))
        )
          throw new JobObservationPending("recovery_required");
      }
      if (
        !remote ||
        !(
          unusedDecision ? ["prepared", "authorized", "settling", "settled"] : ["prepared"]
        ).includes(String(remote.phase)) ||
        remote.prepareOperationKey !== record.prepareOperationKey ||
        remote.prepareOperationFingerprint !== prepared.prepare.operationFingerprint ||
        prepared.state !== "prepared" ||
        prepared.decision !== null ||
        prepared.dmFence?.state !== "prepared" ||
        prepared.generation !== "not_started" ||
        prepared.followUp !== "not_started" ||
        prepared.appliedRevisionId !== null ||
        prepared.apiJobId !== job.jobId ||
        prepared.binding.candidateId !== record.candidateId ||
        prepared.binding.maintenanceId !== record.maintenanceId ||
        prepared.binding.applyOperationKey !== record.operationKey ||
        prepared.binding.applyOperationFingerprint !== opsOperationFingerprint(operation) ||
        prepared.binding.revisionId !== inspected.snapshot.revisionId ||
        prepared.prepare.operationKey !== record.prepareOperationKey ||
        delivery?.state !== "confirmed" ||
        delivery.terminalReceipt.state !== "succeeded" ||
        canonicalJson(observed.binding) !== canonicalJson(prepared.binding) ||
        canonicalJson(observed.prepare) !== canonicalJson(prepared.prepare) ||
        observed.planDigest !== prepared.planDigest ||
        observed.apiJobId !== prepared.apiJobId ||
        observed.parentOperationKey !== prepared.parentOperationKey ||
        observed.parentFingerprint !== prepared.parentFingerprint ||
        observed.parentDeadlineAt !== prepared.parentDeadlineAt ||
        canonicalJson(observed.steps) !== canonicalJson(prepared.steps) ||
        canonicalJson(observed.serviceIds) !== canonicalJson(prepared.serviceIds) ||
        !observed.dmFence ||
        canonicalJson({
          ...observed.dmFence,
          sequence: prepared.dmFence?.sequence,
          state: prepared.dmFence?.state,
        }) !== canonicalJson(prepared.dmFence) ||
        observed.generation !== "not_started" ||
        observed.followUp !== "not_started" ||
        observed.appliedRevisionId !== null ||
        (!unusedDecision && observed.decision !== null) ||
        result._dataExecutions !== undefined ||
        Object.values(projection.operations).some(
          (entry) =>
            !exactRecoveryControl(entry) &&
            ((entry.operationKey !== record.prepareOperationKey &&
              (entry.operationKey !== record.coordinatorPrerequisite?.root.operationKey ||
                canonicalJson(entry.operation) !==
                  canonicalJson(record.coordinatorPrerequisite?.operation))) ||
              !entry.terminal ||
              entry.receiptDelivery?.state !== "confirmed"),
        )
      )
        throw new JobObservationPending("recovery_required");
    }
    if (saved) {
      const decision = configurationMaintenanceDecisionCheckpointSchema.parse(
          result._configurationMaintenanceDecision,
        ),
        { checkpointDigest, ...body } = decision.operation,
        remote = result._configurationMaintenance as Record<string, unknown> | undefined,
        receipt = configurationMaintenanceReceiptSchema.parse(remote?.receipt);
      if (
        body.decision !== "continue" ||
        body.candidateId !== record.candidateId ||
        body.maintenanceId !== record.maintenanceId ||
        body.prepareOperationKey !== record.prepareOperationKey ||
        body.prepareFingerprint !== receipt.prepare.operationFingerprint ||
        body.planDigest !== receipt.planDigest ||
        body.checkpointVersion >= job.execution!.version ||
        canonicalJson(retained.rowVersions) !== canonicalJson(decision.rowVersions) ||
        checkpointDigest !== configurationMaintenanceDbDecisionDigest(body, decision.rowVersions) ||
        receipt.apiJobId !== job.jobId ||
        receipt.prepare.operationKey !== record.prepareOperationKey ||
        receipt.binding.candidateId !== record.candidateId ||
        receipt.binding.applyOperationKey !== record.operationKey ||
        receipt.binding.applyOperationFingerprint !== opsOperationFingerprint(operation) ||
        receipt.binding.revisionId !== inspected.snapshot.revisionId ||
        preparation?.receiptDelivery?.state !== "confirmed"
      )
        throw new JobObservationPending("recovery_required");
      await assertConfigurationSavedRows(tx, decision.rowVersions);
      if (
        coordinator &&
        (decision.rowVersions.some((row) => row.rowVersion !== row.previousRowVersion) ||
          (await sourceFingerprint(read, token)) !== record.sourceFingerprint)
      )
        throw new JobObservationPending("recovery_required");
    }
    // inspectPrepared... already authenticated these EXACT historical bytes.
    // Parsing their payload is not opening an expired apply claim or resealing.
    const payload = trustedConfigurationPayloadSchema.parse(
        JSON.parse(inspected.sealed.toString("utf8")).payload,
      ),
      candidate = Object.freeze({
        candidateId: record.candidateId,
        operationKey: writer.operationKey,
        expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
        revisionId: inspected.snapshot.revisionId,
        sourceFingerprint: record.sourceFingerprint,
        sealedBytes: inspected.sealed.length,
        affectedServiceIds: Object.freeze([...record.affectedServiceIds]),
      }) as ValidatedConfigurationCandidate;
    if (saved && overlay.purpose === "transit-credentials") {
      const { assertSavedTransitCredentialCandidate } = await import(
        "./transit-credential-recovery"
      );
      await assertSavedTransitCredentialCandidate({
        actorId: writer.actorId,
        operationKey: writer.operationKey,
        candidateId: record.candidateId,
        revision: payload.transitCredentialsRevision,
        overlay,
        connection: tx,
      });
    }
    if (saved && platform) {
      const { assertSavedPlatformConfiguration } = await import(
        "./platform-configuration-recovery"
      );
      if (canonicalJson(payload.platform) !== canonicalJson(platform.configuration))
        throw new JobObservationPending("invalid_identity");
      await assertSavedPlatformConfiguration(
        {
          actorId: writer.actorId,
          jobId: job.jobId,
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
          intent: platform,
          checkpoint: result,
        },
        tx,
      );
    }
    freeze(record);
    freeze(overlay);
    freeze(payload);
    freeze(operation);
    const state: CandidateState = {
      writer,
      record,
      overlay,
      payload,
      publisher,
      source: platform?.sourceSnapshot ?? null,
      rows: null,
      sourceRows: null,
      integrationReloadSnapshot: null,
      persisted: saved,
      sealed: {
        revisionId: candidate.revisionId,
        operation,
        operationFingerprint: inspected.snapshot.operationFingerprint,
        bytes: inspected.sealed,
      },
    };
    if (preRoot && coordinator) {
      const prefix =
        coordinator.action === "update"
          ? await (await import("./service-update-batch")).completedServiceUpdatePrefix(
              job.jobId,
              row!.payload,
              result,
              coordinator.originalOrdinal,
            )
          : { operationKeys: new Set<string>(), revisionId: operation.expectedCurrentRevisionId };
      if (prefix.revisionId !== operation.expectedCurrentRevisionId)
        throw new JobObservationPending("invalid_identity");
      const original = record.privateCoordinatorSource,
        fixed = record.coordinatorPrerequisite,
        preview = configurationHardlinksPreviewSchema.parse(retained.preview),
        pull =
          coordinator.action === "update"
            ? projection.operations[coordinator.pull.operationKey]
            : undefined,
        helper = fixed ? projection.operations[fixed.root.operationKey] : undefined;
      const originalAttempt = (
        entry: NonNullable<typeof helper>,
        key: string,
        fingerprint: string,
        deadline: number,
      ) =>
        entry.attempt?.apiJobId === job.jobId &&
        entry.attempt.apiOwnerVersion < job.execution!.version &&
        entry.attempt.childOperationKey === key &&
        entry.attempt.childOperationFingerprint === fingerprint &&
        entry.attempt.requestedDeadlineAt === deadline &&
        entry.attempt.parentOperationKey === record.parentOperationKey &&
        entry.attempt.parentFingerprint === record.parentFingerprint &&
        entry.attempt.parentDeadlineAt === record.parentDeadlineAt;
      if (
        !original ||
        !fixed ||
        overlay.purpose !== "render" ||
        overlay.changes.length !== 0 ||
        overlay.coordinatorMode !== "ensure-running" ||
        !operation.expectedCurrentRevisionId ||
        preview.previewDigest !== retained.previewDigest ||
        original.sourceRevision !== record.expectedSourceRevision ||
        original.revisionId !== operation.expectedCurrentRevisionId ||
        fixed.operation.expectedConfigurationRevisionId !== operation.expectedCurrentRevisionId ||
        canonicalJson(fixed.root.parent) !==
          canonicalJson({
            operationKey: record.parentOperationKey,
            fingerprint: record.parentFingerprint,
            deadlineAt: record.parentDeadlineAt,
          }) ||
        (helper &&
          (helper.kind !== "service.start" ||
            canonicalJson(helper.operation) !== canonicalJson(fixed.operation) ||
            !originalAttempt(
              helper,
              fixed.root.operationKey,
              opsOperationFingerprint(fixed.operation),
              fixed.root.requestedDeadlineAt,
            ))) ||
        (coordinator.action === "update" &&
          (!pull ||
            projection.steps[coordinator.pull.stepAddress]?.operationKey !==
              coordinator.pull.operationKey ||
            canonicalJson(pull.operation) !== canonicalJson(coordinator.pull.operation) ||
            canonicalJson(pull.attempt) !== canonicalJson(coordinator.pull.attempt) ||
            !originalAttempt(
              pull,
              coordinator.pull.operationKey,
              coordinator.pull.operationFingerprint,
              coordinator.pull.requestedDeadlineAt,
            ))) ||
        Object.values(projection.operations).some(
          (entry) =>
            entry !== helper && entry !== pull && !prefix.operationKeys.has(entry.operationKey),
        ) ||
        result._dataExecutions !== undefined
      )
        throw new JobObservationPending("recovery_required");
      if (
        result._cancelRequestedAt !== undefined ||
        Date.now() >= record.parentDeadlineAt ||
        Date.now() >= parseControlRootOperationKey(record.prepareOperationKey!).notAfter ||
        JSON.parse(inspected.sealed.toString()).expiresAt <= new Date().toISOString() ||
        (await sourceFingerprint(read, token)) !== record.sourceFingerprint
      ) {
        candidates.set(candidate, state);
        candidateStages.set(candidate, "recovered_unissued");
        checkpoint = result;
        return candidate;
      }
      // The exact unchanged full source, private MAC candidate and old attempts
      // survive the new owned-row claim. No merge/encryption/seal or clock is
      // reconstructed; an attempted pull is observation-only below.
      state.source = original;
      state.preview = preview;
      state.sourceRows = {
        serviceRows: read.serviceRows,
        integrationRows: read.integrationRows,
        serviceSecretRows: read.serviceSecretRows,
        integrationSecretRows: read.integrationSecretRows,
      };
      state.rows = {
        services: read.services,
        integrations: read.integrations,
        env: read.env,
        serviceRows: read.serviceRows,
        integrationRows: read.integrationRows,
        serviceSecretRows: read.serviceSecretRows,
        integrationSecretRows: read.integrationSecretRows,
      };
      recoveredPreRootCandidates.add(candidate);
    } else if (preRoot && overlay.purpose === "transit-credentials") {
      if (Object.keys(projection.operations).length || result._dataExecutions !== undefined)
        throw new JobObservationPending("recovery_required");
      candidates.set(candidate, state);
      candidateStages.set(candidate, "recovered_unissued");
      checkpoint = result;
      return candidate;
    } else if (preRoot) {
      const original = record.privateMaintenancePreparation!,
        fixed = record.coordinatorPrerequisite,
        helper = fixed && projection.operations[fixed.root.operationKey],
        unattemptedHelper =
          helper === undefined &&
          Object.keys(projection.operations).length === 0 &&
          result._dataExecutions === undefined,
        preview = configurationHardlinksPreviewSchema.parse(retained.preview),
        changes = overlay.changes.filter(
          (change): change is Extract<Overlay["changes"][number], { kind: "service-secret" }> =>
            change.kind === "service-secret",
        );
      if (
        !fixed ||
        overlay.coordinatorMode !== "ensure-running" ||
        !operation.expectedCurrentRevisionId ||
        !preview.entries ||
        preview.previewDigest !== retained.previewDigest ||
        original.source.sourceRevision !== record.expectedSourceRevision ||
        original.source.revisionId !== operation.expectedCurrentRevisionId ||
        fixed.operation.expectedConfigurationRevisionId !== operation.expectedCurrentRevisionId ||
        canonicalJson(fixed.root.parent) !==
          canonicalJson({
            operationKey: record.parentOperationKey,
            fingerprint: record.parentFingerprint,
            deadlineAt: record.parentDeadlineAt,
          }) ||
        (!unattemptedHelper &&
          (!helper?.attempt ||
            helper.kind !== "service.start" ||
            canonicalJson(helper.operation) !== canonicalJson(fixed.operation) ||
            helper.attempt.apiJobId !== job.jobId ||
            helper.attempt.apiOwnerVersion >= job.execution!.version ||
            helper.attempt.childOperationKey !== fixed.root.operationKey ||
            helper.attempt.childOperationFingerprint !== opsOperationFingerprint(fixed.operation) ||
            helper.attempt.requestedDeadlineAt !== fixed.root.requestedDeadlineAt)) ||
        canonicalJson(original.serviceSecrets.map((row) => row.key).sort()) !==
          canonicalJson(
            changes
              .filter((change) => change.action === "set")
              .map((change) => change.key)
              .sort(),
          )
      )
        throw new JobObservationPending("recovery_required");
      if (
        result._cancelRequestedAt !== undefined ||
        Date.now() >= record.parentDeadlineAt ||
        Date.now() >= parseControlRootOperationKey(record.prepareOperationKey!).notAfter ||
        JSON.parse(inspected.sealed.toString()).expiresAt <= new Date().toISOString() ||
        (await sourceFingerprint(read, token)) !== record.sourceFingerprint
      ) {
        // The original private bytes/locked prepared checkpoint prove which
        // helper to OBSERVE, or its explicit nonissuance before this new claim.
        // The cleanup rechecks that original locked no-attempt state. This
        // recovery-only stage has no prepared rows/source and cannot persist,
        // render, reseal or prepare a maintenance root.
        candidates.set(candidate, state);
        candidateStages.set(candidate, "recovered_unissued");
        checkpoint = result;
        return candidate;
      }
      // These are the exact PREPARED row IDs/ciphertexts/timestamps. Current
      // untouched rows are accepted only after their complete original source
      // HMAC matches; nothing is merged, encrypted, rendered or sealed again.
      // An unattempted helper may first use ONLY its already-fixed body/root/
      // deadline. The new owned row lock fenced the former writer, and every
      // POST requires its durable child attempt; no missing lookup is success.
      const changedKeys = new Set(changes.map((change) => change.key)),
        preparedRows = original.serviceSecrets.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        }));
      state.source = original.source;
      state.preview = preview;
      state.sourceRows = {
        serviceRows: read.serviceRows,
        integrationRows: read.integrationRows,
        serviceSecretRows: read.serviceSecretRows,
        integrationSecretRows: read.integrationSecretRows,
      };
      state.rows = {
        services: read.services,
        integrations: read.integrations,
        env: read.env,
        serviceRows: read.serviceRows,
        integrationRows: read.integrationRows,
        integrationSecretRows: read.integrationSecretRows,
        serviceSecretRows: [
          ...read.serviceSecretRows.filter(
            (row) => row.serviceId !== "data-manager" || !changedKeys.has(row.key),
          ),
          ...preparedRows,
        ],
      };
      recoveredPreRootCandidates.add(candidate);
    }
    candidates.set(candidate, state);
    candidateStages.set(
      candidate,
      saved
        ? "committed"
        : rolledBack
          ? "rolled_back"
          : preRoot
            ? "prepared"
            : "recovered_pre_save",
    );
    if (saved) recoveredCommittedCandidates.add(candidate);
    checkpoint = result;
    return candidate;
  });
  if (!checkpoint) throw new JobObservationPending("recovery_required");
  job.checkpointResult = checkpoint;
  return candidate;
}
/** The existing ordinary generation producer, with no reload/credential or
 * participant continuation. Its saved row receipts and exact original private
 * packet are authoritative; current desired values never rebuild its seal. */
async function restoreRetainedOrdinaryCandidate(): Promise<ValidatedConfigurationCandidate> {
  const writer = currentAdministrativeConfigurationWriter(),
    owner = administrativeConfigurationState(writer),
    { job } = owner;
  if (!job.execution || job.execution.version < 2 || owner.participant)
    throw new JobObservationPending("recovery_required");
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
    publisher = publisherOptions(token);
  let checkpoint: Record<string, unknown> | undefined;
  const candidate = await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined;
    if (
      !result ||
      !["saved", "follow_up_pending"].includes(String(retained?.phase)) ||
      retained?.operationKey !== writer.operationKey ||
      retained.maintenanceId !== null ||
      retained.prepareOperationKey !== null ||
      typeof retained.sealedOperationKey !== "string" ||
      result._configurationMaintenance !== undefined ||
      result._configurationMaintenanceDecision !== undefined
    )
      throw new JobObservationPending("recovery_required");
    const inspected = await readPreparedTrustedConfigurationCandidate(
        publisher,
        retained.sealedOperationKey,
      ),
      record = inspected.record,
      operation = opsOperationSchema.parse(record.operation),
      overlay = overlaySchema.parse(record.privateOverlay),
      parent = {
        operationKey: record.parentOperationKey,
        fingerprint: record.parentFingerprint,
        deadlineAt: record.parentDeadlineAt,
      },
      projection = readProjection(result),
      attempt = projection.operations[record.operationKey],
      allowed =
        (operation.kind === "stack.render" &&
          overlay.purpose === "render" &&
          overlay.changes.length === 0) ||
        (operation.kind === "serviceSelection.apply" &&
          overlay.purpose === "selection" &&
          overlay.changes.length === 1 &&
          overlay.changes[0]?.kind === "selection") ||
        (operation.kind === "serviceConfig.apply" &&
          overlay.purpose === "service-config" &&
          overlay.changes.length === 1 &&
          overlay.changes[0]?.kind === "service-config" &&
          overlay.changes[0].serviceId === operation.serviceId) ||
        (operation.kind === "integrationConfig.apply" &&
          ["integration-config", "integration-secret", "integration-binding"].includes(
            overlay.purpose,
          ) &&
          overlay.changes.length === 1 &&
          "integrationId" in overlay.changes[0]! &&
          overlay.changes[0].integrationId === operation.integrationId &&
          overlay.changes[0].kind === overlay.purpose) ||
        (operation.kind === "stack.render" &&
          overlay.purpose === "migration" &&
          !!record.privateIntegrationReload?.legacyImport);
    const reload = record.apiFollowUp === "integration-reload",
      credential = record.apiFollowUp === "service-apply",
      ordinaryCredential =
        credential &&
        operation.kind === "vault.apply" &&
        operation.serviceId !== "data-manager" &&
        overlay.purpose === "service-secret" &&
        overlay.changes.length === 1 &&
        overlay.changes[0]?.kind === "service-secret" &&
        overlay.changes[0].serviceId === operation.serviceId &&
        job.jobType === "service.apply";
    if (
      !(allowed || ordinaryCredential) ||
      ![
        "stack.render",
        "serviceSelection.apply",
        "serviceConfig.apply",
        "integrationConfig.apply",
        "vault.apply",
      ].includes(operation.kind) ||
      !("expectedCurrentRevisionId" in operation) ||
      !("expectedSourceRevision" in operation) ||
      !("coordinatorMode" in operation) ||
      ("maintenanceId" in operation && operation.maintenanceId !== undefined) ||
      ("candidateId" in operation && operation.candidateId !== undefined) ||
      record.maintenanceId !== null ||
      record.prepareOperationKey !== null ||
      !(
        record.apiFollowUp === "none" ||
        (reload && record.privateIntegrationReload) ||
        ordinaryCredential
      ) ||
      record.apiJobId !== job.jobId ||
      record.actorId !== writer.actorId ||
      record.candidateId !== retained.candidateId ||
      record.sourceFingerprint !== retained.sourceFingerprint ||
      inspected.snapshot.revisionId !== retained.revisionId ||
      operation.expectedSourceRevision !== record.expectedSourceRevision ||
      operation.coordinatorMode !== overlay.coordinatorMode ||
      inspected.snapshot.operationFingerprint !== opsOperationFingerprint(operation) ||
      canonicalJson(writer.integrationIds) !==
        canonicalJson(retainedIntegrationIds(record, overlay)) ||
      reload !==
        (operation.kind === "integrationConfig.apply" || overlay.purpose === "migration") ||
      (overlay.purpose === "migration") !== (job.jobType === "integration.config.import") ||
      (result._parentExecution !== undefined &&
        canonicalJson(result._parentExecution) !== canonicalJson(parent)) ||
      (attempt &&
        (!attempt.attempt ||
          attempt.attempt.apiJobId !== job.jobId ||
          attempt.attempt.apiOwnerVersion >= job.execution!.version ||
          canonicalJson(attempt.operation) !== canonicalJson(operation)))
    )
      throw new JobObservationPending("recovery_required");
    const rows = z.array(configurationSavedRowSchema).max(512).parse(retained.rowVersions);
    await assertConfigurationSavedRows(tx, rows);
    const payload = trustedConfigurationPayloadSchema.parse(
        JSON.parse(inspected.sealed.toString("utf8")).payload,
      ),
      candidate = Object.freeze({
        candidateId: record.candidateId,
        operationKey: writer.operationKey,
        expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
        revisionId: inspected.snapshot.revisionId,
        sourceFingerprint: record.sourceFingerprint,
        sealedBytes: inspected.sealed.length,
        affectedServiceIds: Object.freeze([...record.affectedServiceIds]),
      }) as ValidatedConfigurationCandidate;
    if (overlay.purpose === "integration-binding")
      await assertSavedIntegrationBinding(candidate, overlay, tx);
    freeze(record);
    freeze(operation);
    freeze(overlay);
    freeze(payload);
    candidates.set(candidate, {
      writer,
      record,
      overlay,
      payload,
      publisher,
      source: null,
      rows: null,
      sourceRows: null,
      integrationReloadSnapshot: null,
      persisted: true,
      sealed: {
        revisionId: candidate.revisionId,
        operation,
        operationFingerprint: inspected.snapshot.operationFingerprint,
        bytes: inspected.sealed,
      },
    });
    candidateStages.set(candidate, "committed");
    recoveredCommittedCandidates.add(candidate);
    checkpoint = result;
    return candidate;
  });
  if (!checkpoint) throw new JobObservationPending("recovery_required");
  job.checkpointResult = checkpoint;
  return candidate;
}
/** Death before the candidate checkpoint cannot authorize reconstruction or
 * another pull. Close only the original never-issued slot; an authenticated
 * orphan packet, if present, is usable solely for exact inert-file cleanup. */
export async function reconcileUnstagedCoordinatorPull(): Promise<void> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer);
  if (
    job.jobType !== "service.bulk" ||
    !job.execution ||
    job.execution.version < 2 ||
    job.checkpointResult?._configurationCandidate !== undefined
  )
    return;
  let original: Record<string, unknown> | undefined,
    entry: ReturnType<typeof readProjection>["operations"][string] | undefined;
  await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(job.jobId, job.execution))
      .for("update");
    if (
      !row ||
      row.type !== job.jobType ||
      canonicalJson(row.payload) !== canonicalJson(job.payload)
    )
      throw new JobObservationPending("invalid_identity");
    original = (row.result ?? {}) as Record<string, unknown>;
    if (original._configurationCandidate !== undefined)
      throw new JobObservationPending("recovery_required");
    const { parseServiceUpdateBatch, completedServiceUpdatePrefix } = await import(
        "./service-update-batch"
      ),
      batch = parseServiceUpdateBatch(row.payload, original),
      ordinal = batch.serviceIds.indexOf("data-manager"),
      projection = readProjection(original),
      address = createDurableOpsKey("configuration.coordinator-pull", `${job.jobId}:${ordinal}`);
    entry = projection.operations[projection.steps[address]?.operationKey ?? address];
    if (!entry) return;
    const prefix = await completedServiceUpdatePrefix(job.jobId, row.payload, original, ordinal);
    if (
      !["prepared", "unissued"].includes(entry.phase) ||
      entry.operation?.kind !== "service.pull" ||
      entry.operation.serviceId !== "data-manager" ||
      !entry.operation.candidateId ||
      entry.operation.expectedConfigurationRevisionId !== prefix.revisionId ||
      entry.attempt?.apiJobId !== job.jobId ||
      entry.attempt.apiOwnerVersion >= job.execution!.version ||
      Object.values(projection.operations).some(
        (value) => value !== entry && !prefix.operationKeys.has(value.operationKey),
      ) ||
      original._configurationMaintenance !== undefined ||
      original._dataExecutions !== undefined
    )
      throw new JobObservationPending("recovery_required");
  });
  if (!entry || !original) return;
  job.checkpointResult = original;
  const operation = entry.operation;
  if (operation?.kind !== "service.pull" || !operation.candidateId)
    throw new JobObservationPending("invalid_identity");
  const publisher = publisherOptions(
      await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
    ),
    retained = await findPreparedTrustedConfigurationCandidate(publisher, operation.candidateId);
  if (retained) {
    const record = retained.record,
      [row] = await administrativeConfigurationState(writer)
        .connection.select()
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution));
    if (!row) throw new JobObservationPending("recovery_required");
    const fixed = assertRetainedCoordinatorLifecycleProvenance(row, record);
    if (
      fixed.action !== "update" ||
      record.candidateId !== operation.candidateId ||
      canonicalJson(fixed.pull.operation) !== canonicalJson(entry.operation) ||
      canonicalJson(fixed.pull.attempt) !== canonicalJson(entry.attempt) ||
      fixed.pull.operationKey !== entry.operationKey
    )
      throw new JobObservationPending("invalid_identity");
  }
  await closeUnissuedCoordinatorPull(job, operation.candidateId, retained?.record.operationKey);
  if (retained) {
    const record = retained.record,
      typed = opsOperationSchema.parse(record.operation);
    if (!("expectedCurrentRevisionId" in typed))
      throw new JobObservationPending("invalid_identity");
    const candidate = Object.freeze({
      candidateId: record.candidateId,
      operationKey: writer.operationKey,
      expectedCurrentRevisionId: typed.expectedCurrentRevisionId,
      revisionId: retained.snapshot.revisionId,
      sourceFingerprint: record.sourceFingerprint,
      sealedBytes: retained.sealed.length,
      affectedServiceIds: Object.freeze([...record.affectedServiceIds]),
    }) as ValidatedConfigurationCandidate;
    candidates.set(candidate, {
      writer,
      record,
      overlay: overlaySchema.parse(record.privateOverlay),
      payload: trustedConfigurationPayloadSchema.parse(
        JSON.parse(retained.sealed.toString()).payload,
      ),
      publisher,
      source: null,
      rows: null,
      sourceRows: null,
      integrationReloadSnapshot: null,
      persisted: false,
      sealed: {
        revisionId: candidate.revisionId,
        operation: typed,
        operationFingerprint: retained.snapshot.operationFingerprint,
        bytes: retained.sealed,
      },
    });
    candidateStages.set(candidate, "unissued");
    await discardUnadmittedTrustedConfigurationCandidate(candidate);
    candidateStages.set(candidate, "discarded");
  }
  throw new AdminJobFailure("Original configuration candidate was not issued", {
    configuration: {
      outcome: "not_committed",
      reason: "conflict",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    },
  });
}
/** Fixed replacement-owner continuation. Every attempted operation is looked
 * up at its original address. Only the exact locked pre-save state permits
 * recording ABANDON; there is no fresh preparation, desired save or seal. */
export async function resumeRetainedConfigurationCandidate(): Promise<Record<string, unknown>> {
  const current = administrativeConfigurationState(currentAdministrativeConfigurationWriter()).job
    .checkpointResult?._configurationCandidate as Record<string, unknown> | undefined;
  if (current?.retirement !== undefined) return resumeCompletedConfigurationRetirement();
  let candidate: ValidatedConfigurationCandidate;
  try {
    const { job } = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
      retained = job.checkpointResult?._configurationCandidate as
        | Record<string, unknown>
        | undefined;
    candidate = await (retained?.maintenanceId === null
      ? restoreRetainedOrdinaryCandidate()
      : restoreRetainedMaintenanceCandidate());
  } catch {
    throw new JobObservationPending("recovery_required");
  }
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    maintenance = await configurationMaintenanceProtocol;
  if (candidateStages.get(candidate) === "recovered_unissued") {
    await discardUnissuedMaintenanceCandidate(candidate);
    if (job.checkpointResult?._cancelRequestedAt !== undefined)
      return completeUnissuedConfigurationCancellation(candidate);
    const configuration: TrustedConfigurationApplyOutcome = {
      outcome: "not_committed",
      reason: "conflict",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    };
    await job.checkpoint({
      ...job.checkpointResult,
      configuration,
      _configurationOutcomes: {
        ...(job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: configuration,
      },
    });
    return { configuration };
  }
  if (recoveredPreRootCandidates.has(candidate)) {
    const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
      coordinatorMode: state.overlay.coordinatorMode,
      signal: job.signal,
    });
    return { configuration: receipt.application };
  }
  if (recoveredCommittedCandidates.has(candidate)) {
    const receipt = state.record.maintenanceId
      ? await persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode: state.overlay.coordinatorMode,
          signal: job.signal,
        })
      : await applyCommittedOrdinaryCandidate(candidate, job.signal);
    if (
      !state.record.maintenanceId &&
      state.record.apiFollowUp === "service-apply" &&
      completeTrustedConfigurationApply(receipt.application)
    )
      await completeProspectiveServiceCredential(candidate);
    if (
      state.record.apiFollowUp !== "integration-reload" ||
      !completeTrustedConfigurationApply(receipt.application)
    )
      return { configuration: receipt.application };
    if (
      state.overlay.purpose === "integration-binding" ||
      (state.overlay.purpose === "integration-secret" &&
        state.overlay.changes.some(
          (change) => change.kind === "integration-secret" && change.expectedRevision,
        ))
    ) {
      const applied = await completeIntegrationActivation(candidate, receipt.application);
      return {
        configuration: receipt.application,
        [state.overlay.purpose === "integration-binding"
          ? "integrationBinding"
          : "integrationApplication"]: applied,
      };
    }
    // An interrupted activation is not permission to invoke setup again. Only
    // an unattempted reload may begin; a durable completion can be copied.
    const original = job.checkpointResult?.integrationReload as Record<string, unknown> | undefined;
    if (
      original &&
      (original.state !== "complete" ||
        original.candidateId !== candidate.candidateId ||
        original.revisionId !== candidate.revisionId)
    )
      throw new JobObservationPending("recovery_required");
    let reloaded: { message: string; reloaded: number; enabled: number };
    if (original)
      reloaded = z
        .strictObject({
          message: z.string(),
          reloaded: z.number().int().nonnegative(),
          enabled: z.number().int().nonnegative(),
        })
        .parse(original.result);
    else {
      await job.checkpoint({
        ...job.checkpointResult,
        integrationReload: {
          state: "attempted",
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
        },
      });
      try {
        reloaded = await reloadProspectiveIntegrations(candidate);
      } catch {
        throw new JobObservationPending("recovery_required");
      }
      await job.checkpoint({
        ...job.checkpointResult,
        _configurationCandidate: {
          ...(job.checkpointResult?._configurationCandidate as Record<string, unknown>),
          phase: "settled",
        },
        integrationReload: {
          state: "complete",
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
          result: reloaded,
        },
      });
    }
    await retireSettledProspectiveConfiguration(candidate);
    const provenance = state.record.privateIntegrationReload?.legacyImport;
    return {
      configuration: receipt.application,
      ...(provenance
        ? {
            integrationImport: {
              ok: true,
              imported: provenance.changedIntegrationIds.length,
              skipped: provenance.integrationIds.filter(
                (id) => !provenance.changedIntegrationIds.includes(id),
              ),
              ...reloaded,
            },
          }
        : {}),
    };
  }
  try {
    await maintenance.prepareConfigurationMaintenance(candidate);
  } catch (error) {
    const preparation =
      state.record.prepareOperationKey &&
      readProjection(job.checkpointResult).operations[state.record.prepareOperationKey];
    if (
      preparation &&
      preparation.terminal &&
      preparation.receiptDelivery?.state === "confirmed" &&
      ["failed", "timed_out"].includes(preparation.receiptDelivery.terminalReceipt.state)
    )
      return { configuration: await completeNeverPreparedConfiguration(candidate) };
    throw error;
  }
  const retainedAbandon = job.checkpointResult?._configurationMaintenanceDecision;
  const abandon =
    retainedAbandon === undefined
      ? await maintenance.prepareConfigurationMaintenanceAbandon(candidate)
      : configurationMaintenanceDecisionCheckpointSchema.parse(retainedAbandon).operation;
  if (abandon.decision !== "abandon") throw new JobObservationPending("recovery_required");
  await maintenance.decideConfigurationMaintenance(abandon);
  const observed = await maintenance.inspectConfigurationMaintenance({
    maintenanceId: state.record.maintenanceId!,
    candidateId: candidate.candidateId,
  });
  const settlement = job.checkpointResult?._configurationMaintenanceSettle;
  await maintenance.settleConfigurationMaintenance(
    settlement === undefined
      ? {
          kind: "configurationMaintenance.settle",
          maintenanceId: observed.binding.maintenanceId,
          candidateId: candidate.candidateId,
          prepareOperationKey: observed.prepare.operationKey,
          prepareFingerprint: observed.prepare.operationFingerprint,
          planDigest: observed.planDigest,
          decisionId: abandon.decisionId,
          expectedSequence: observed.sequence,
          evidenceDigest: configurationMaintenanceSettleRequestDigest(observed),
        }
      : configurationMaintenanceSettleCheckpointSchema.parse(settlement).operation,
  );
  await discardUnusedPreparedProspectiveConfiguration(candidate);
  if (job.checkpointResult?._cancelRequestedAt !== undefined)
    return completeUnusedConfigurationCancellation(candidate);
  const configuration: TrustedConfigurationApplyOutcome = {
    outcome: "not_committed",
    reason: "conflict",
    cleanupFailed: false,
    publisherCleanupFailed: false,
    registryUpdateFailed: false,
  };
  await job.checkpoint({
    ...job.checkpointResult,
    configuration,
    _configurationOutcomes: {
      ...(job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
      [candidate.operationKey]: configuration,
    },
  });
  return { configuration };
}
function fieldDefinition(schema: Record<string, unknown> | undefined, key: string) {
  const fields = (schema?.properties ?? schema ?? {}) as Record<string, Record<string, unknown>>;
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}
function validateOverlay(overlay: Overlay, writer: AdministrativeConfigurationWriter): void {
  const state = administrativeConfigurationState(writer);
  if (overlay.purpose === "migration") assertLegacyIntegrationImportOverlay(writer, overlay);
  if (overlay.purpose === "integration-binding") assertIntegrationBindingOverlay(writer, overlay);
  if (overlay.purpose === "migration" && state.participant?.kind !== "configuration-migration")
    throw Error("Configuration commit participant unavailable");
  if (overlay.purpose === "platform") assertPlatformConfigurationOverlay(writer, overlay);
  if (
    overlay.changes.some((change) => change.kind === "platform") &&
    overlay.purpose !== "platform"
  )
    throw Error("Platform configuration participant required");
  const fields = new Set<string>();
  for (const change of overlay.changes) {
    if (change.kind === "platform") continue;
    const target =
      "serviceId" in change
        ? change.serviceId
        : "integrationId" in change
          ? change.integrationId
          : "selection";
    if ("integrationId" in change && !writer.integrationIds.includes(change.integrationId))
      throw Error("Configuration integration lock unavailable");
    const keys =
      change.kind === "integration-binding"
        ? [change.capability]
        : "set" in change
          ? [...Object.keys(change.set), ...change.unset]
          : "key" in change
            ? [change.key]
            : ["selection"];
    for (const key of keys) {
      const identity = `${change.kind.startsWith("integration") ? "integration" : "service"}:${target}:${key}`;
      if (fields.has(identity)) throw Error("Conflicting configuration overlay");
      fields.add(identity);
    }
    if (
      change.kind === "service-secret" &&
      change.serviceId === "data-manager" &&
      change.key === "TRANSITOUS_API_KEYS"
    ) {
      if (
        overlay.purpose !== "transit-credentials" ||
        !state.participant?.managedServiceSecretKeys.some(
          (item) => item.serviceId === "data-manager" && item.key === change.key,
        )
      )
        throw Error("Managed credential participant unavailable");
    }
  }
  const serviceIds = new Set(
    overlay.changes.flatMap((change) =>
      change.kind !== "integration-binding" && "serviceId" in change && change.serviceId
        ? [change.serviceId]
        : [],
    ),
  );
  const integrationIds = new Set(
    overlay.changes.flatMap((change) => ("integrationId" in change ? [change.integrationId] : [])),
  );
  if (
    (overlay.purpose === "render" && overlay.changes.length) ||
    (overlay.purpose === "selection" &&
      (overlay.changes.length !== 1 || overlay.changes[0]?.kind !== "selection")) ||
    (["service-config", "service-secret", "transit-credentials"].includes(overlay.purpose) &&
      (serviceIds.size !== 1 || integrationIds.size > 0)) ||
    (["integration-config", "integration-secret", "integration-binding"].includes(
      overlay.purpose,
    ) &&
      (integrationIds.size !== 1 || serviceIds.size > 0))
  )
    throw Error("Configuration purpose conflicts with overlay");
  const permitted = {
    "service-config": "service-config",
    "service-secret": "service-secret",
    "integration-config": "integration-config",
    "integration-secret": "integration-secret",
    "integration-binding": "integration-binding",
    "transit-credentials": "service-secret",
    selection: "selection",
    platform: "platform",
  } as const;
  const kind = permitted[overlay.purpose as keyof typeof permitted];
  if (overlay.purpose === "platform" && overlay.changes.length !== 1)
    throw Error("Single fixed platform intent required");
  if (kind && overlay.changes.some((change) => change.kind !== kind))
    throw Error("Configuration purpose conflicts with overlay");
}

async function mergeOverlay(
  context: AdministrativeConfigurationReadContext,
  overlay: Overlay,
  source: ConfigurationSourcesInspection,
) {
  const rows = {
    services: context.services,
    integrations: context.integrations,
    env: context.env,
    bindingRows: context.bindingRows,
    bindingRevisionRows: context.bindingRevisionRows,
    integrationBindingSnapshot: Object.fromEntries(
      [...new Set((context.bindingRows ?? []).map((row) => row.integrationId))].map((id) => [
        id,
        Object.fromEntries(
          (context.bindingRows ?? [])
            .filter((row) => row.integrationId === id)
            .map((row) => [row.capability, row.serviceId]),
        ),
      ]),
    ),
    serviceRows: structuredClone([...context.serviceRows]),
    integrationRows: structuredClone([...context.integrationRows]),
    serviceSecretRows: structuredClone([...context.serviceSecretRows]),
    integrationSecretRows: structuredClone([...context.integrationSecretRows]),
  };
  const now = new Date();
  for (const change of overlay.changes) {
    if (change.kind === "integration-binding") {
      const bindings = rows.integrationBindingSnapshot[change.integrationId] ?? {};
      if (change.serviceId) bindings[change.capability] = change.serviceId;
      else delete bindings[change.capability];
      rows.integrationBindingSnapshot[change.integrationId] = bindings;
      continue;
    }
    if (change.kind === "platform" || change.kind === "selection") continue;
    const service =
      "serviceId" in change
        ? context.services.find((service) => service.manifest.id === change.serviceId)
        : undefined;
    const integration =
      "integrationId" in change
        ? context.integrations.find((integration) => integration.id === change.integrationId)
        : undefined;
    const manifest = service?.manifest ?? integration?.manifest;
    if (!manifest) throw Error("Unknown configuration target");
    const resolved = service
      ? await resolveServiceConfigWithSourcesStrict(
          {
            id: service.manifest.id,
            configSchema: service.manifest.configSchema,
            containerEnv: service.manifest.container.environment,
            containerMemory: service.manifest.container.memory,
            isBuiltIn: service.isBuiltIn,
          },
          context,
        )
      : await resolveIntegrationConfigWithSourcesStrict(
          integration!.manifest,
          integration!.directory,
          context,
        );
    if (
      change.kind === "integration-secret" &&
      change.expectedRevision &&
      (await integrationOwnershipSnapshot(change.integrationId, context)).revision !==
        change.expectedRevision
    )
      throw new IntegrationConfigurationConflict();
    const changedKeys =
      "set" in change ? [...Object.keys(change.set), ...change.unset] : [change.key];
    for (const key of changedKeys) {
      const definition =
        integration && key === "enabled"
          ? { type: "boolean" }
          : fieldDefinition(manifest.configSchema, key);
      if (
        !definition ||
        definition.readOnly === true ||
        "key" in change !== (definition["x-openmapx-secret"] === true)
      )
        throw Error("Undeclared or immutable configuration field");
      const host =
        service &&
        source.services
          .find((item) => item.serviceId === service.manifest.id)
          ?.fields.find((field) => field.key === key);
      if (host?.source === "host" || ["env", "config.json"].includes(resolved[key]?.source ?? ""))
        throw new ConfigurationSourceOwned(
          projectFieldOwnership({
            source: host?.source === "host" ? "env" : resolved[key]!.source,
            secret: definition["x-openmapx-secret"] === true,
            envVar: host?.envVar,
          }),
        );
    }
    if (change.kind === "service-config") {
      let row = rows.serviceRows.find((row) => row.serviceId === change.serviceId);
      if (!row) {
        row = {
          id: randomUUID(),
          serviceId: change.serviceId,
          config: {},
          createdAt: now,
          updatedAt: now,
        };
        rows.serviceRows.push(row);
      }
      row.config = { ...row.config, ...change.set };
      for (const key of change.unset) delete row.config[key];
    } else if (change.kind === "integration-config") {
      let row = rows.integrationRows.find((row) => row.integrationId === change.integrationId);
      if (!row) {
        row = {
          id: randomUUID(),
          integrationId: change.integrationId,
          config: {},
          createdAt: now,
          updatedAt: now,
        };
        rows.integrationRows.push(row);
      }
      row.config = { ...row.config, ...change.set };
      for (const key of change.unset) delete row.config[key];
    } else if (change.kind === "service-secret") {
      const managedPrior =
        change.serviceId === "data-manager" && change.key === "TRANSITOUS_API_KEYS"
          ? rows.serviceSecretRows.find(
              (row) => row.serviceId === change.serviceId && row.key === change.key,
            )
          : undefined;
      rows.serviceSecretRows = rows.serviceSecretRows.filter(
        (row) => row.serviceId !== change.serviceId || row.key !== change.key,
      );
      if (change.action === "set")
        rows.serviceSecretRows.push({
          id: managedPrior?.id ?? randomUUID(),
          serviceId: change.serviceId,
          key: change.key,
          ...encrypt(change.value),
          createdAt: now,
          updatedAt: now,
          updatedBy: null,
        });
    } else {
      rows.integrationSecretRows = rows.integrationSecretRows.filter(
        (row) => row.integrationId !== change.integrationId || row.key !== change.key,
      );
      if (change.action === "set")
        rows.integrationSecretRows.push({
          id: randomUUID(),
          integrationId: change.integrationId,
          key: change.key,
          ...encrypt(change.value),
          createdAt: now,
          updatedAt: now,
          updatedBy: null,
        });
    }
  }
  return rows;
}

export async function prepareProspectiveConfiguration(input: {
  actorId: string;
  expectedCurrentRevisionId: string | null;
  overlay: ProspectiveConfigurationOverlay;
  operationKey: string;
  signal?: AbortSignal;
  followUp?: "service-apply";
  coordinatorIntent?: CoordinatorLifecycleIntent;
}): Promise<ValidatedConfigurationCandidate> {
  const writer = currentAdministrativeConfigurationWriter();
  if (writer.actorId !== input.actorId || writer.operationKey !== input.operationKey)
    throw Error("Configuration writer identity conflict");
  const owner = administrativeConfigurationState(writer);
  if (owner.job.jobType === "service.bulk" && owner.job.payload.action === "update") {
    const { advanceCompletedBulkCandidate } = await import("./service-update-batch");
    await advanceCompletedBulkCandidate(writer);
  }
  const coordinator = input.coordinatorIntent
    ? await assertCoordinatorLifecycleIntent(input.coordinatorIntent, writer)
    : null;
  input.signal?.throwIfAborted();
  const overlay = overlaySchema.parse(input.overlay);
  const platformIntent =
    overlay.purpose === "platform" ? retainedPlatformConfigurationIntent(writer) : undefined;
  if (overlay.purpose === "transit-credentials") {
    const { assertTransitCredentialOverlay } = await import(
      "./transit-feed-credential-participant"
    );
    assertTransitCredentialOverlay(writer, overlay);
  }
  validateOverlay(overlay, writer);
  if (
    coordinator &&
    (input.expectedCurrentRevisionId === null ||
      input.followUp ||
      canonicalJson(overlay) !==
        canonicalJson({ purpose: "render", coordinatorMode: "ensure-running", changes: [] }))
  )
    throw Error("Fixed unchanged coordinator render required");
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
  const publisher = publisherOptions(token);
  const source = platformIntent
    ? retainedPlatformConfigurationSource(writer)
    : await executeAndWait(
        createApiOpsClient(),
        { kind: "configuration.sources.inspect" },
        createDurableOpsKey("configuration.sources.inspect", input.operationKey),
        { signal: input.signal },
      );
  if (source.revisionId !== input.expectedCurrentRevisionId)
    throw Error("Configuration revision conflict");
  let cleanupOperationKey: string | undefined;
  const result = await withAdministrativeConfigurationRead(
    { signal: input.signal },
    async (context) => {
      const fingerprint = await sourceFingerprint(context, token);
      const merged = await mergeOverlay(context, overlay, source);
      const read = openAdministrativeConfigurationRead(merged);
      try {
        const { buildConfigurationInput } = await import("./configuration-input");
        const selection = overlay.changes.find((change) => change.kind === "selection");
        const payload = trustedConfigurationPayloadSchema.parse({
          ...(await withAdministrativeConfigurationReadScope(read, () =>
            buildConfigurationInput(read, platformIntent?.configuration ?? source.platform),
          )),
          ...(selection?.kind === "selection" ? { selectedRoots: selection.selectedRoots } : {}),
        });
        if (platformIntent)
          assertPlatformConfigurationSource(writer, source, {
            services: context.services,
            env: context.env,
            resolvedServiceConfigs: new Map(
              payload.serviceConfigs.map((entry) => [entry.serviceId, entry.values]),
            ),
          });
        const integrationReloadSnapshot = await withAdministrativeConfigurationReadScope(
          read,
          async () =>
            Object.fromEntries(
              await Promise.all(
                read.integrations.map(
                  async (integration) =>
                    [
                      integration.id,
                      await resolveIntegrationConfigWithSourcesStrict(
                        integration.manifest,
                        integration.directory,
                        read,
                      ),
                    ] as const,
                ),
              ),
            ),
        );
        freeze(integrationReloadSnapshot);
        if ((await sourceFingerprint(context, token)) !== fingerprint)
          throw Error("Configuration source changed during preparation");
        for (const entry of payload.serviceConfigs) {
          const manifest = context.services.find(
            (service) => service.manifest.id === entry.serviceId,
          )!.manifest;
          if (!coreServices.validateTrustedConfigurationValues(entry.values, manifest.configSchema))
            throw Error("Configuration schema rejected");
        }
        const candidateId = coordinator?.candidateId ?? randomUUID();
        const affectedServiceIds = platformIntent
          ? [...platformIntent.affectedServiceIds]
          : coordinator
            ? ["data-manager"]
            : [
                ...new Set(
                  overlay.changes.flatMap((change) =>
                    change.kind !== "integration-binding" &&
                    "serviceId" in change &&
                    change.serviceId
                      ? [change.serviceId]
                      : [],
                  ),
                ),
              ].sort();
        const kind =
          overlay.purpose === "selection"
            ? "serviceSelection.apply"
            : overlay.purpose === "service-config"
              ? "serviceConfig.apply"
              : overlay.purpose === "service-secret" || overlay.purpose === "transit-credentials"
                ? "vault.apply"
                : overlay.purpose.startsWith("integration-")
                  ? "integrationConfig.apply"
                  : "stack.render";
        if (input.followUp && (kind !== "vault.apply" || affectedServiceIds.length !== 1))
          throw Error("Invalid credential continuation");
        const maintenanceId =
          platformIntent ||
          coordinator ||
          (input.followUp && affectedServiceIds[0] === "data-manager")
            ? randomUUID()
            : null;
        const apiFollowUp =
          (platformIntent
            ? "platform-apply"
            : coordinator
              ? (`coordinator-${coordinator.action}` as const)
              : input.followUp) ??
          (kind === "integrationConfig.apply" ||
          (overlay.purpose === "migration" && owner.participant?.kind === "configuration-migration")
            ? "integration-reload"
            : "none");
        const root = maintenanceId
          ? prepareAdminJobOperationRoot(
              owner.job,
              "configurationMaintenance.prepare",
              createDurableOpsKey(
                "configuration-maintenance.prepare",
                `${owner.job.jobId}:${candidateId}`,
              ),
            )
          : prepareAdminJobOperationRoot(owner.job, kind, input.operationKey);
        const coordinatorLifecycle = coordinator
          ? coordinator.action === "apply"
            ? {
                version: 1 as const,
                serviceId: "data-manager" as const,
                action: "apply" as const,
                originalOrdinal: null,
                noDeps: false as const,
              }
            : {
                version: 1 as const,
                serviceId: "data-manager" as const,
                action: "update" as const,
                originalOrdinal: coordinator.originalOrdinal!,
                noDeps: coordinator.noDeps,
                pull: await reserveCoordinatorPullSubmission(
                  owner.job,
                  input.coordinatorIntent!,
                  input.expectedCurrentRevisionId!,
                  root.parent,
                ),
              }
          : undefined;
        const applyOperationKey = maintenanceId
          ? controlChildOperationKey(root.operationKey, "configuration-commit", 0)
          : root.operationKey;
        cleanupOperationKey = applyOperationKey;
        const prerequisiteAddress = createDurableOpsKey(
          "configuration-maintenance.coordinator",
          `${owner.job.jobId}:${candidateId}`,
        );
        const coordinatorPrerequisite =
          maintenanceId &&
          overlay.coordinatorMode === "ensure-running" &&
          input.expectedCurrentRevisionId !== null
            ? {
                stepAddress: prerequisiteAddress,
                operation: {
                  kind: "service.start" as const,
                  serviceId: "data-manager" as const,
                  expectedConfigurationRevisionId: input.expectedCurrentRevisionId,
                },
                root: prepareAdminJobOperationRoot(
                  {
                    ...owner.job,
                    checkpointResult: {
                      ...owner.job.checkpointResult,
                      _parentExecution: root.parent,
                    },
                  },
                  "service.start",
                  prerequisiteAddress,
                ),
              }
            : null;
        const operationForRevision = (revisionId: string): OpsOperation =>
          ({
            kind,
            revisionId,
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            expectedSourceRevision: source.sourceRevision,
            coordinatorMode: overlay.coordinatorMode,
            ...(maintenanceId ? { maintenanceId, candidateId } : {}),
            ...(kind === "serviceConfig.apply" || kind === "vault.apply"
              ? { serviceId: affectedServiceIds[0]! }
              : {}),
            ...(kind === "integrationConfig.apply"
              ? { integrationId: (overlay.changes[0] as { integrationId: string }).integrationId }
              : {}),
          }) as OpsOperation;
        const sealed = sealTrustedConfigurationSnapshot({
          role: "api",
          operationKey: applyOperationKey,
          operationForRevision,
          payload,
          token,
          nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        });
        const record: PreparedConfigurationRecord = {
          version: 1,
          candidateId,
          operationKey: applyOperationKey,
          operation: sealed.operation,
          sourceFingerprint: fingerprint,
          expectedSourceRevision: source.sourceRevision,
          sealed: sealed.bytes.toString("base64"),
          privateOverlay: overlay,
          apiJobId: owner.job.jobId,
          actorId: writer.actorId,
          parentOperationKey: root.parent.operationKey,
          parentFingerprint: root.parent.fingerprint,
          parentDeadlineAt: root.parent.deadlineAt,
          affectedServiceIds,
          apiFollowUp,
          ...(platformIntent ? { privatePlatformIntent: platformIntent } : {}),
          ...(coordinatorLifecycle
            ? {
                privateCoordinatorLifecycle: coordinatorLifecycle,
                privateCoordinatorSource: source,
              }
            : {}),
          maintenanceId,
          prepareOperationKey: maintenanceId ? root.operationKey : null,
          coordinatorPrerequisite,
          ...(maintenanceId && !owner.participant && overlay.purpose === "service-secret"
            ? {
                privateMaintenancePreparation: {
                  version: 1 as const,
                  source,
                  serviceSecrets: merged.serviceSecretRows
                    .filter(
                      (row) =>
                        row.serviceId === "data-manager" &&
                        overlay.changes.some(
                          (change) =>
                            change.kind === "service-secret" &&
                            change.serviceId === row.serviceId &&
                            change.key === row.key &&
                            change.action === "set",
                        ),
                    )
                    .map((row) => ({
                      id: row.id,
                      serviceId: "data-manager" as const,
                      key: row.key,
                      ciphertext: row.ciphertext,
                      iv: row.iv,
                      tag: row.tag,
                      createdAt: row.createdAt.toISOString(),
                      updatedAt: row.updatedAt.toISOString(),
                      updatedBy: row.updatedBy,
                    })),
                },
              }
            : {}),
          ...(apiFollowUp === "integration-reload"
            ? {
                privateIntegrationReload: {
                  version: 1 as const,
                  services: [...merged.services],
                  integrations: merged.integrations.map((i) => ({
                    id: i.id,
                    directory: i.directory,
                    manifest: i.manifest,
                    isBuiltIn: i.isBuiltIn,
                  })),
                  values: integrationReloadSnapshot,
                  bindings: merged.integrationBindingSnapshot,
                  ...(overlay.purpose === "migration"
                    ? {
                        legacyImport: (
                          await import("./configuration-migration/legacy-integration-import-intent")
                        ).retainedLegacyIntegrationImportIntent(writer),
                      }
                    : {}),
                },
              }
            : {}),
        };
        const candidate = Object.freeze({
          candidateId,
          operationKey: input.operationKey,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          revisionId: sealed.revisionId,
          sourceFingerprint: fingerprint,
          sealedBytes: sealed.bytes.length,
          affectedServiceIds: Object.freeze(affectedServiceIds),
        }) as ValidatedConfigurationCandidate;
        freeze(overlay);
        freeze(payload);
        freeze(record);
        candidates.set(candidate, {
          writer,
          overlay,
          payload,
          sealed,
          record,
          publisher,
          source,
          rows: merged,
          sourceRows: {
            serviceRows: context.serviceRows,
            integrationRows: context.integrationRows,
            serviceSecretRows: context.serviceSecretRows,
            integrationSecretRows: context.integrationSecretRows,
          },
          persisted: false,
          integrationReloadSnapshot,
        });
        candidateStages.set(candidate, "preflight");
        await verifyConfigurationCommitParticipant(candidate, writer);
        assertRowReceiptBudget(
          savedRowIntents(validatedConfigurationCandidateState(candidate)).map((row) => ({
            ...row,
            rowVersion: row.state === "present" ? "4294967295" : null,
          })),
        );
        await retainPreparedTrustedConfigurationCandidate(publisher, record);
        const state = validatedConfigurationCandidateState(candidate);
        let preflightStage: "preview" | "coordinator" | "capacity" = "preview";
        try {
          state.preview = await executeAndWait(
            createApiOpsClient(),
            {
              kind: "configuration.hardlinks.preview",
              candidateId,
              revisionId: candidate.revisionId,
              expectedCurrentRevisionId: input.expectedCurrentRevisionId,
              expectedSourceRevision: source.sourceRevision,
              coordinatorMode: overlay.coordinatorMode,
            },
            createDurableOpsKey("configuration.hardlinks.preview", input.operationKey),
            { signal: input.signal },
          );
          preflightStage = "coordinator";
          if (
            overlay.coordinatorMode === "require-running" &&
            (state.preview.entries ||
              coordinator ||
              platformIntent ||
              (maintenanceId && input.followUp === "service-apply")) &&
            state.preview.coordinatorState !== "running"
          )
            throw Error("Configuration coordinator prerequisite unavailable");
          if (
            maintenanceId &&
            overlay.coordinatorMode === "ensure-running" &&
            (state.preview.entries || coordinator) &&
            (input.expectedCurrentRevisionId === null ||
              !["running", "stopped"].includes(state.preview.coordinatorState))
          )
            throw Error("Configuration coordinator prerequisite unavailable");
          preflightStage = "capacity";
          assertMaintenanceIntentCapacity(state, owner.job.checkpointResult);
        } catch (error) {
          if (coordinator?.action === "update")
            await closeUnissuedCoordinatorPull(owner.job, candidateId, record.operationKey);
          // Preview is read-only. This exact inert candidate has no apply/guard
          // admission, so a conclusive local refusal may free its reserved queue slot.
          await discardUnadmittedTrustedConfigurationCandidate(candidate);
          candidateStages.set(candidate, "discarded");
          // This operation is read-only and the exact local slot/packet closure
          // above proves no apply/maintenance/pull dispatch. A lost preview
          // response is a known local preflight failure, not an unknown effect.
          const { ApiOpsError } = await import("./ops-client");
          if (error instanceof ApiOpsError && error.errorClass === "configuration_prerequisite") {
            const { ConfigurationPrerequisiteFailure } = await import("./admin-job-failure");
            throw new ConfigurationPrerequisiteFailure();
          }
          throw new AdminJobFailure("Configuration candidate preflight failed", {
            errorCode: "configuration_preflight_failed",
            configurationPreflight: {
              stage: preflightStage,
              coordinatorState: state.preview?.coordinatorState ?? null,
              errorClass: error instanceof ApiOpsError ? error.errorClass : "local_validation",
            },
          });
        }
        candidateStages.set(candidate, "prepared");
        return candidate;
      } finally {
        closeAdministrativeConfigurationRead(read);
      }
    },
  ).catch(async (error) => {
    if (coordinator?.action === "update")
      await closeUnissuedCoordinatorPull(owner.job, coordinator.candidateId, cleanupOperationKey);
    throw error;
  });
  return result;
}

/** Local count arithmetic only. No future decision body/root is allocated.
 * All exact known middle-owner addresses plus the two original controls must
 * fit the existing shared64 map before helper/pull; later CAS still rechecks. */
function assertMaintenanceIntentCapacity(state: CandidateState, result: unknown): void {
  const record = state.record;
  if (!record.maintenanceId || !record.prepareOperationKey) return;
  const projection = readProjection(result),
    keys = new Set<string>([record.prepareOperationKey]);
  const platform = record.privatePlatformIntent;
  const recreate = platform
    ? record.affectedServiceIds.filter(
        (id) => !protectedConfigurationServiceIdSchema.safeParse(id).success,
      )
    : record.apiFollowUp === "service-apply" || record.privateCoordinatorLifecycle
      ? record.affectedServiceIds
      : [];
  const handoff =
    !!platform &&
    record.affectedServiceIds.some(
      (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
    );
  const count = 1 + (state.preview?.entries ? 1 : 0) + recreate.length + (handoff ? 1 : 0);
  if (count > 32) throw Error("Prospective maintenance effect capacity exceeded");
  keys.add(controlChildOperationKey(record.prepareOperationKey, "configuration-commit", 0));
  let ordinal = 1;
  if (state.preview?.entries)
    keys.add(
      controlChildOperationKey(record.prepareOperationKey, "maintenance-hardlinks", ordinal++),
    );
  for (const _service of recreate)
    keys.add(
      controlChildOperationKey(record.prepareOperationKey, "maintenance-recreate", ordinal++),
    );
  if (handoff)
    keys.add(
      controlChildOperationKey(record.prepareOperationKey, "maintenance-handoff", ordinal++),
    );
  if (
    record.coordinatorPrerequisite &&
    (state.preview?.entries || record.privateCoordinatorLifecycle)
  )
    keys.add(record.coordinatorPrerequisite.root.operationKey);
  const missing = [...keys].filter((key) => !projection.operations[key]).length;
  if (
    Math.max(Object.keys(projection.operations).length, Object.keys(projection.steps).length) +
      missing +
      2 >
    64
  )
    throw Error("Prospective maintenance intent capacity exceeded");
}

function savedRowIntents(state: CandidateState) {
  const { rows, sourceRows } = state;
  if (state.record.privatePlatformIntent)
    return [
      {
        kind: "platform" as const,
        ownerId: "platform",
        rowId: "platformConfiguration",
        previousRowVersion: state.record.privatePlatformIntent.expectedDesiredRowVersion,
        state: "present" as const,
      },
    ];
  if (!rows || !sourceRows) throw Error("Original prospective desired state required");
  if (state.record.privateCoordinatorLifecycle) {
    const rowVersion = (row: object) => {
      const version = (row as { _rowVersion?: unknown })._rowVersion;
      if (typeof version !== "string" || !/^\d{1,10}$/.test(version))
        throw Error("Configuration row version unavailable");
      return version;
    };
    // The unchanged full desired snapshot is recorded truthfully, without a
    // dummy write, resave, new ciphertext or invented xmin.
    const ordinary = (
      kind: "service-config" | "integration-config",
      values: typeof sourceRows.serviceRows | typeof sourceRows.integrationRows,
    ) =>
      values.map((row) => ({
        kind,
        ownerId: "serviceId" in row ? row.serviceId : row.integrationId,
        rowId: row.id,
        previousRowVersion: rowVersion(row),
        key: undefined as string | undefined,
        state: "present" as const,
      }));
    const secrets = (
      kind: "service-secret" | "integration-secret",
      values: typeof sourceRows.serviceSecretRows | typeof sourceRows.integrationSecretRows,
    ) =>
      values.map((row) => ({
        kind,
        ownerId: "serviceId" in row ? row.serviceId : row.integrationId,
        key: row.key,
        rowId: row.id,
        previousRowVersion: rowVersion(row),
        state: "present" as const,
      }));
    const receipts = [
      ...ordinary("service-config", sourceRows.serviceRows),
      ...ordinary("integration-config", sourceRows.integrationRows),
      ...secrets("service-secret", sourceRows.serviceSecretRows),
      ...secrets("integration-secret", sourceRows.integrationSecretRows),
    ];
    if (receipts.length > 512 || receipts.some((row) => !/^\d{1,10}$/.test(row.previousRowVersion)))
      throw Error("Configuration unchanged row receipt capacity unavailable");
    return receipts;
  }
  const seen = new Set<string>();
  return state.overlay.changes.flatMap((change) => {
    if (
      change.kind === "selection" ||
      change.kind === "platform" ||
      change.kind === "integration-binding"
    )
      return [];
    const ownerId = "serviceId" in change ? change.serviceId : change.integrationId;
    const secretKey = "key" in change ? change.key : undefined,
      identity = `${change.kind}:${ownerId}:${secretKey ?? ""}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const source =
      change.kind === "service-config"
        ? sourceRows.serviceRows.find((row) => row.serviceId === ownerId)
        : change.kind === "integration-config"
          ? sourceRows.integrationRows.find((row) => row.integrationId === ownerId)
          : change.kind === "service-secret"
            ? sourceRows.serviceSecretRows.find(
                (row) => row.serviceId === ownerId && row.key === secretKey,
              )
            : sourceRows.integrationSecretRows.find(
                (row) => row.integrationId === ownerId && row.key === secretKey,
              );
    const desired =
      change.kind === "service-config"
        ? rows.serviceRows.find((row) => row.serviceId === ownerId)
        : change.kind === "integration-config"
          ? rows.integrationRows.find((row) => row.integrationId === ownerId)
          : change.kind === "service-secret"
            ? rows.serviceSecretRows.find(
                (row) => row.serviceId === ownerId && row.key === secretKey,
              )
            : rows.integrationSecretRows.find(
                (row) => row.integrationId === ownerId && row.key === secretKey,
              );
    if (!source && !desired) return [];
    const rowId = source?.id ?? desired!.id,
      previousRowVersion = source ? (source as { _rowVersion?: unknown })._rowVersion : null;
    if (
      typeof rowId !== "string" ||
      rowId.length > 128 ||
      (previousRowVersion !== null &&
        (typeof previousRowVersion !== "string" || !/^\d{1,10}$/.test(previousRowVersion)))
    )
      throw Error("Configuration row version unavailable");
    return [
      {
        kind: change.kind,
        ownerId,
        ...(secretKey ? { key: secretKey } : {}),
        rowId,
        previousRowVersion: previousRowVersion as string | null,
        state: desired ? ("present" as const) : ("absent" as const),
      },
    ];
  });
}
function assertRowReceiptBudget(rows: unknown) {
  if (Buffer.byteLength(canonicalJson(rows)) > 65536)
    throw Error("Configuration row receipt capacity unavailable");
}
async function readSavedRowVersions(
  tx: ConfigurationWriteTransaction,
  state: CandidateState,
): Promise<ConfigurationSavedRow[]> {
  // Same transaction/physical connection as the writes. No values or secret
  // hashes enter the checkpoint; versions belong to this actual SQL outcome.
  const serviceRows = await tx
    .select({
      id: schema.serviceConfig.id,
      ownerId: schema.serviceConfig.serviceId,
      rowVersion: sql<string>`xmin::text`,
    })
    .from(schema.serviceConfig);
  const integrationRows = await tx
    .select({
      id: schema.integrationConfig.id,
      ownerId: schema.integrationConfig.integrationId,
      rowVersion: sql<string>`xmin::text`,
    })
    .from(schema.integrationConfig);
  const serviceSecrets = await tx
    .select({
      id: schema.serviceSecret.id,
      ownerId: schema.serviceSecret.serviceId,
      key: schema.serviceSecret.key,
      rowVersion: sql<string>`xmin::text`,
    })
    .from(schema.serviceSecret);
  const integrationSecrets = await tx
    .select({
      id: schema.integrationSecret.id,
      ownerId: schema.integrationSecret.integrationId,
      key: schema.integrationSecret.key,
      rowVersion: sql<string>`xmin::text`,
    })
    .from(schema.integrationSecret);
  const intents = savedRowIntents(state);
  const platformRows = intents.some((row) => row.kind === "platform")
    ? await tx
        .select({
          id: schema.systemSettings.key,
          ownerId: sql<string>`'platform'`,
          rowVersion: sql<string>`xmin::text`,
        })
        .from(schema.systemSettings)
        .where(eq(schema.systemSettings.key, "platformConfiguration"))
    : [];
  const receipts = intents.map((intent) => {
    const rows =
      intent.kind === "platform"
        ? platformRows
        : intent.kind === "service-config"
          ? serviceRows
          : intent.kind === "integration-config"
            ? integrationRows
            : intent.kind === "service-secret"
              ? serviceSecrets
              : integrationSecrets;
    const key = "key" in intent ? intent.key : undefined;
    const matches = rows.filter(
      (row) => row.ownerId === intent.ownerId && (!key || ("key" in row && row.key === key)),
    );
    if (intent.state === "absent") {
      if (matches.length) throw Error("Configuration deletion receipt conflict");
      return { ...intent, rowVersion: null };
    }
    if (
      matches.length !== 1 ||
      matches[0]!.id !== intent.rowId ||
      !/^\d{1,10}$/.test(matches[0]!.rowVersion)
    )
      throw Error("Configuration saved row receipt conflict");
    return { ...intent, rowVersion: matches[0]!.rowVersion };
  });
  assertRowReceiptBudget(receipts);
  return receipts;
}

async function persistOverlay(
  tx: ConfigurationWriteTransaction,
  state: CandidateState,
  candidate: ValidatedConfigurationCandidate,
) {
  if (!state.rows || !state.sourceRows) throw Error("Original prospective desired state required");
  const version = (row: { id: string } | undefined) => {
    const value = (row as { _rowVersion?: unknown } | undefined)?._rowVersion;
    if (row && (typeof value !== "string" || !/^\d+$/.test(value)))
      throw Error("Configuration row version unavailable");
    return value as string;
  };
  const one = (rows: unknown[]) => {
    if (rows.length !== 1) throw Error("Configuration row ownership conflict");
  };
  const touched = new Set<string>();
  for (const change of state.overlay.changes) {
    if (change.kind === "service-config") {
      const row = state.rows.serviceRows.find((row) => row.serviceId === change.serviceId)!;
      if (touched.has(`s:${row.serviceId}`)) continue;
      touched.add(`s:${row.serviceId}`);
      const prior = state.sourceRows.serviceRows.find((item) => item.serviceId === row.serviceId);
      if (prior)
        one(
          await tx
            .update(schema.serviceConfig)
            .set({ config: row.config, updatedAt: new Date() })
            .where(and(eq(schema.serviceConfig.id, prior.id), sql`xmin::text = ${version(prior)}`))
            .returning({ id: schema.serviceConfig.id }),
        );
      else
        one(
          await tx
            .insert(schema.serviceConfig)
            .values({ id: row.id, serviceId: row.serviceId, config: row.config })
            .onConflictDoNothing()
            .returning({ id: schema.serviceConfig.id }),
        );
    } else if (change.kind === "integration-config") {
      const row = state.rows.integrationRows.find(
        (row) => row.integrationId === change.integrationId,
      )!;
      if (touched.has(`i:${row.integrationId}`)) continue;
      touched.add(`i:${row.integrationId}`);
      const prior = state.sourceRows.integrationRows.find(
        (item) => item.integrationId === row.integrationId,
      );
      if (prior)
        one(
          await tx
            .update(schema.integrationConfig)
            .set({ config: row.config, updatedAt: new Date() })
            .where(
              and(eq(schema.integrationConfig.id, prior.id), sql`xmin::text = ${version(prior)}`),
            )
            .returning({ id: schema.integrationConfig.id }),
        );
      else
        one(
          await tx
            .insert(schema.integrationConfig)
            .values({ id: row.id, integrationId: row.integrationId, config: row.config })
            .onConflictDoNothing()
            .returning({ id: schema.integrationConfig.id }),
        );
    } else if (change.kind === "service-secret") {
      const owner = administrativeConfigurationState(state.writer);
      if (
        owner.participant?.managedServiceSecretKeys.some(
          (entry) => entry.serviceId === change.serviceId && entry.key === change.key,
        )
      ) {
        const { transitParticipantPatch } = await import("./transit-feed-credential-participant");
        await persistPreparedFeedCredentialPatch({
          patch: transitParticipantPatch(owner.participant, state.writer),
          candidate,
          writer: state.writer,
        });
        continue;
      }
      const prior = state.sourceRows.serviceSecretRows.find(
        (row) => row.serviceId === change.serviceId && row.key === change.key,
      );
      const where =
        prior && and(eq(schema.serviceSecret.id, prior.id), sql`xmin::text = ${version(prior)}`);
      if (change.action === "delete") {
        if (prior)
          one(
            await tx
              .delete(schema.serviceSecret)
              .where(where)
              .returning({ id: schema.serviceSecret.id }),
          );
      } else {
        const row = state.rows.serviceSecretRows.find(
          (row) => row.serviceId === change.serviceId && row.key === change.key,
        )!;
        if (prior)
          one(
            await tx
              .update(schema.serviceSecret)
              .set({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, updatedAt: new Date() })
              .where(where)
              .returning({ id: schema.serviceSecret.id }),
          );
        else
          one(
            await tx
              .insert(schema.serviceSecret)
              .values(row)
              .onConflictDoNothing()
              .returning({ id: schema.serviceSecret.id }),
          );
      }
    } else if (change.kind === "integration-secret") {
      const prior = state.sourceRows.integrationSecretRows.find(
        (row) => row.integrationId === change.integrationId && row.key === change.key,
      );
      const where =
        prior &&
        and(eq(schema.integrationSecret.id, prior.id), sql`xmin::text = ${version(prior)}`);
      if (change.action === "delete") {
        if (prior)
          one(
            await tx
              .delete(schema.integrationSecret)
              .where(where)
              .returning({ id: schema.integrationSecret.id }),
          );
      } else {
        const row = state.rows.integrationSecretRows.find(
          (row) => row.integrationId === change.integrationId && row.key === change.key,
        )!;
        if (prior)
          one(
            await tx
              .update(schema.integrationSecret)
              .set({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, updatedAt: new Date() })
              .where(where)
              .returning({ id: schema.integrationSecret.id }),
          );
        else
          one(
            await tx
              .insert(schema.integrationSecret)
              .values(row)
              .onConflictDoNothing()
              .returning({ id: schema.integrationSecret.id }),
          );
      }
    }
  }
  return readSavedRowVersions(tx, state);
}

async function verifyCurrentPreview(
  candidate: ValidatedConfigurationCandidate,
  state: CandidateState,
  signal?: AbortSignal,
) {
  if (!state.source) throw Error("Original prospective preview source required");
  const preview = await executeAndWait(
    createApiOpsClient(),
    {
      kind: "configuration.hardlinks.preview",
      candidateId: candidate.candidateId,
      revisionId: candidate.revisionId,
      expectedCurrentRevisionId: candidate.expectedCurrentRevisionId,
      expectedSourceRevision: state.source.sourceRevision,
      coordinatorMode: state.overlay.coordinatorMode,
    },
    createDurableOpsKey("configuration.hardlinks.preview", candidate.operationKey),
    { signal },
  );
  if (
    preview.previewDigest !== state.preview?.previewDigest ||
    (state.overlay.coordinatorMode === "require-running" &&
      (preview.entries ||
        (state.record.maintenanceId &&
          (state.record.apiFollowUp === "service-apply" || state.record.privatePlatformIntent))) &&
      preview.coordinatorState !== "running")
  )
    rejectUnissuedCandidate(candidate, "Configuration preview changed");
  return preview;
}

/** The ordinary prerequisite is deliberately outside the maintenance graph.
 * Its exact old-revision body/address/deadline were sealed in the inert private
 * candidate. Managed execution persists the admission attempt before POST and
 * completes only after authenticated terminal receipt delivery and release. */
async function prepareMaintenanceCoordinator(
  candidate: ValidatedConfigurationCandidate,
  state: CandidateState,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !state.record.maintenanceId ||
    (!state.preview?.entries && !state.record.privateCoordinatorLifecycle) ||
    state.overlay.coordinatorMode !== "ensure-running"
  )
    return;
  const owner = administrativeConfigurationState(state.writer),
    fixed = state.record.coordinatorPrerequisite;
  if (
    !fixed ||
    !candidate.expectedCurrentRevisionId ||
    fixed.operation.expectedConfigurationRevisionId !== candidate.expectedCurrentRevisionId ||
    fixed.root.parent.operationKey !== state.record.parentOperationKey ||
    fixed.root.parent.fingerprint !== state.record.parentFingerprint ||
    fixed.root.parent.deadlineAt !== state.record.parentDeadlineAt ||
    fixed.root.operationKey === state.record.prepareOperationKey
  )
    throw Error("Configuration coordinator prerequisite unavailable");
  signal?.throwIfAborted();
  owner.job.signal.throwIfAborted();
  if (
    Date.now() >= fixed.root.requestedDeadlineAt ||
    JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString()
  )
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  await withAdministrativeConfigurationRead({ signal }, async (read) => {
    if ((await sourceFingerprint(read, state.publisher.token)) !== candidate.sourceFingerprint)
      rejectUnissuedCandidate(candidate, "Configuration source conflict");
  });
  await verifyConfigurationCommitParticipant(candidate, state.writer);
  // Explicit lifecycle candidates observe an already-ready OLD coordinator.
  // In particular never Compose up after Update has staged a new image.
  const beforePull =
    state.record.privateCoordinatorLifecycle?.action === "update"
      ? readProjection(owner.job.checkpointResult).operations[
          state.record.privateCoordinatorLifecycle.pull.operationKey
        ]
      : undefined;
  if (state.record.privateCoordinatorLifecycle && beforePull && beforePull.phase !== "prepared") {
    const helper = readProjection(owner.job.checkpointResult).operations[fixed.root.operationKey];
    if (helper)
      await executeAdminJobOperation(
        owner.job,
        fixed.operation,
        "configuration-maintenance.coordinator",
        { operationKey: fixed.stepAddress, preparedRoot: fixed.root },
      );
    const ready = await verifyCurrentPreview(candidate, state, signal);
    if (ready.coordinatorState !== "running") throw new JobObservationPending("recovery_required");
    return;
  }
  if (state.record.privateCoordinatorLifecycle && state.preview?.coordinatorState === "running") {
    await verifyCurrentPreview(candidate, state, signal);
    return;
  }
  if (beforePull && beforePull.phase !== "prepared")
    throw new JobObservationPending("recovery_required");
  await executeAdminJobOperation(
    owner.job,
    fixed.operation,
    "configuration-maintenance.coordinator",
    {
      operationKey: fixed.stepAddress,
      preparedRoot: fixed.root,
    },
  );
  signal?.throwIfAborted();
  owner.job.signal.throwIfAborted();
  if (JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString())
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  await withAdministrativeConfigurationRead({ signal }, async (read) => {
    if ((await sourceFingerprint(read, state.publisher.token)) !== candidate.sourceFingerprint)
      rejectUnissuedCandidate(candidate, "Configuration source conflict");
  });
  const ready = await verifyCurrentPreview(candidate, state, signal);
  if (ready.coordinatorState !== "running")
    rejectUnissuedCandidate(candidate, "Configuration coordinator prerequisite unavailable");
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCoordinatorPrerequisite: {
      candidateId: candidate.candidateId,
      operationKey: fixed.root.operationKey,
      stepAddress: fixed.stepAddress,
      expectedRevisionId: candidate.expectedCurrentRevisionId,
      state: "settled_ready",
    },
  });
}

function candidateCheckpoint(candidate: ValidatedConfigurationCandidate, state: CandidateState) {
  return {
    candidateId: candidate.candidateId,
    operationKey: candidate.operationKey,
    revisionId: candidate.revisionId,
    sourceFingerprint: candidate.sourceFingerprint,
    phase: "prepared",
    previewDigest: state.preview?.previewDigest,
    preview: state.preview,
    coordinatorMode: state.overlay.coordinatorMode,
    sealedOperationKey: state.record.operationKey,
    maintenanceId: state.record.maintenanceId,
    prepareOperationKey: state.record.prepareOperationKey,
  };
}
/** Shared ownership-only entry: the exact inert candidate and ordinary OLD
 * revision coordinator prerequisite precede the first maintenance admission.
 * This never persists desired rows or publishes a consumable apply claim. */
export async function stageProspectiveConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
  signal?: AbortSignal,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    checkpoint = candidateCheckpoint(candidate, state),
    retained = owner.job.checkpointResult?._configurationCandidate as
      | Record<string, unknown>
      | undefined,
    parent = {
      operationKey: state.record.parentOperationKey,
      fingerprint: state.record.parentFingerprint,
      deadlineAt: state.record.parentDeadlineAt,
    };
  if (
    candidateStages.get(candidate) !== "prepared" ||
    !state.record.maintenanceId ||
    owner.transactionActive ||
    owner.participant?.mode === "preview" ||
    (retained &&
      (retained.candidateId !== checkpoint.candidateId ||
        retained.operationKey !== checkpoint.operationKey ||
        retained.sealedOperationKey !== checkpoint.sealedOperationKey ||
        retained.phase !== "prepared")) ||
    (owner.job.checkpointResult?._parentExecution &&
      canonicalJson(owner.job.checkpointResult._parentExecution) !== canonicalJson(parent))
  )
    throw Error("Original inert maintenance candidate required");
  await verifyConfigurationCommitParticipant(candidate, state.writer);
  if (!retained)
    await owner.job.checkpoint({
      ...owner.job.checkpointResult,
      _configurationCandidate: checkpoint,
      _parentExecution: parent,
    });
  if (JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString())
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  await verifyCurrentPreview(candidate, state, signal);
  await prepareMaintenanceCoordinator(candidate, state, signal);
  if (state.record.privateCoordinatorLifecycle?.action === "update") {
    try {
      await deliverCoordinatorPullSubmission(owner.job, candidate.candidateId);
    } catch (error) {
      const { ApiOpsError } = await import("./ops-client"),
        pull = readProjection(owner.job.checkpointResult).operations[
          state.record.privateCoordinatorLifecycle.pull.operationKey
        ];
      // Only this fixed delivery's confirmed original failure selects cleanup.
      // The locked nonissuance producer still re-observes its actual ACK and
      // excludes every maintenance/save attempt before removing the packet.
      if (
        error instanceof ApiOpsError &&
        error.errorClass !== "recovery_required" &&
        pull?.phase === "terminal" &&
        pull.terminal &&
        pull.receiptDelivery?.state === "confirmed" &&
        ["failed", "timed_out"].includes(pull.receiptDelivery.terminalReceipt.state)
      )
        rejectUnissuedCandidate(candidate, "Original coordinator pull failed before maintenance");
      throw error;
    }
    if (JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString())
      rejectUnissuedCandidate(candidate, "Configuration candidate expired");
    await verifyCurrentPreview(candidate, state, signal);
  }
}

/** The fixed prepared candidate producer. Desired rows, participant commit,
 * actual xmin receipts and ONE continue decision share the original writer
 * connection/transaction. This entry does not publish an apply claim or issue
 * a host grant; the persister coordinates those only after decision delivery. */
export async function commitProspectiveConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<ConfigurationMaintenanceDecision> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    record = state.record,
    stage = candidateStages.get(candidate),
    maintenance = await configurationMaintenanceProtocol;
  if (
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    !owner.job.execution ||
    owner.transactionActive ||
    owner.participant?.mode === "preview" ||
    !["prepared", "committed"].includes(stage ?? "")
  )
    throw Error("Original maintenance candidate transaction required");
  if (stage === "committed") {
    let observed: Record<string, unknown> | undefined;
    const operation = await withConfigurationWriteTransaction(state.writer, async (tx) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined,
        source = configurationMaintenanceDecisionCheckpointSchema.parse(
          result?._configurationMaintenanceDecision,
        ),
        { checkpointDigest, ...body } = source.operation;
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.revisionId !== candidate.revisionId ||
        retained.sealedOperationKey !== record.operationKey ||
        retained.maintenanceId !== record.maintenanceId ||
        retained.phase !== "saved" ||
        body.decision !== "continue" ||
        body.candidateId !== candidate.candidateId ||
        body.prepareOperationKey !== record.prepareOperationKey ||
        canonicalJson(retained.rowVersions) !== canonicalJson(source.rowVersions) ||
        checkpointDigest !== configurationMaintenanceDbDecisionDigest(body, source.rowVersions)
      )
        throw Error("Original committed maintenance decision required");
      await assertConfigurationSavedRows(tx, source.rowVersions);
      observed = result;
      return source.operation;
    });
    if (!observed) throw new JobObservationPending("recovery_required");
    owner.job.checkpointResult = observed;
    return operation;
  }
  const prepared = await maintenance.prepareConfigurationMaintenance(candidate),
    checkpoint = candidateCheckpoint(candidate, state);
  if (
    prepared.state !== "prepared" ||
    prepared.decision !== null ||
    prepared.dmFence?.state !== "prepared" ||
    prepared.generation !== "not_started" ||
    prepared.followUp !== "not_started" ||
    prepared.preflight !== "current"
  )
    throw Error("Original prepared maintenance reservation required");
  await verifyCurrentPreview(candidate, state, owner.job.signal);
  await verifyConfigurationCommitParticipant(candidate, state.writer);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: { ...checkpoint, phase: "save_attempted" },
  });
  candidateStages.set(candidate, "save_attempted");
  let committed: Record<string, unknown> | undefined,
    decision: ConfigurationMaintenanceDecision | undefined;
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx, context) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined,
        remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
        preparation = readProjection(result).operations[record.prepareOperationKey!];
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.operationKey !== candidate.operationKey ||
        retained.sealedOperationKey !== record.operationKey ||
        retained.revisionId !== candidate.revisionId ||
        retained.phase !== "save_attempted" ||
        retained.rowVersions !== undefined ||
        remote?.phase !== "prepared" ||
        canonicalJson(remote.receipt) !== canonicalJson(prepared) ||
        result._configurationMaintenanceDecision !== undefined ||
        result._configurationMaintenanceRollback !== undefined ||
        hasPendingReceiptDelivery(result) ||
        hasUnsettledManagedOperation(result) ||
        preparation?.receiptDelivery?.state !== "confirmed" ||
        preparation.receiptDelivery.terminalReceipt.state !== "succeeded" ||
        canonicalJson(preparation.receiptDelivery.terminalReceipt.result) !==
          canonicalJson(prepared)
      )
        throw Error("Original owned prepared candidate checkpoint required");
      if ((await sourceFingerprint(context, state.publisher.token)) !== candidate.sourceFingerprint)
        throw Error("Configuration source conflict");
      if (JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString())
        throw Error("Configuration candidate expired");
      await verifyConfigurationCommitParticipant(candidate, state.writer);
      await verifyCurrentPreview(candidate, state, owner.job.signal);
      const fresh = await maintenance.inspectConfigurationMaintenance({
        maintenanceId: record.maintenanceId!,
        candidateId: candidate.candidateId,
      });
      if (
        fresh.preflight !== "current" ||
        canonicalJson({ ...fresh, preflight: prepared.preflight }) !== canonicalJson(prepared)
      )
        throw Error("Original prepared maintenance preflight changed");
      await owner.participant?.commit(candidate, state.writer, tx);
      const rowVersions = await persistOverlay(tx, state, candidate),
        body = {
          kind: "configurationMaintenance.decide" as const,
          maintenanceId: record.maintenanceId!,
          candidateId: candidate.candidateId,
          prepareOperationKey: record.prepareOperationKey!,
          prepareFingerprint: prepared.prepare.operationFingerprint,
          planDigest: prepared.planDigest,
          decisionId: randomUUID(),
          decision: "continue" as const,
          expectedSequence: prepared.sequence,
          checkpointVersion: owner.job.execution!.version,
        };
      decision = configurationMaintenanceDecisionSchema.parse({
        ...body,
        checkpointDigest: configurationMaintenanceDbDecisionDigest(body, rowVersions),
      });
      const source = configurationMaintenanceDecisionCheckpointSchema.parse({
          version: 1,
          operation: decision,
          rowVersions,
          attempt: "not_attempted",
        }),
        [latest] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update");
      if (!latest) throw Error("Configuration job ownership changed");
      committed = {
        ...(latest.result as Record<string, unknown>),
        _configurationCandidate: { ...checkpoint, phase: "saved", rowVersions },
        _configurationMaintenanceDecision: source,
      };
      const saved = await tx
        .update(schema.adminJob)
        .set({ result: committed })
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .returning({ id: schema.adminJob.id });
      if (saved.length !== 1) throw Error("Configuration job ownership changed");
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteRolledBack) {
      // This catch consumes the actual transaction wrapper's conclusive native
      // rollback, never a caller-supplied error, boolean or row-absence guess.
      candidateStages.set(candidate, "rolled_back");
      let rollbackCheckpoint: Record<string, unknown> | undefined;
      await withConfigurationWriteTransaction(state.writer, async (tx) => {
        const [row] = await tx
            .select({ result: schema.adminJob.result })
            .from(schema.adminJob)
            .where(jobOwnership(owner.job.jobId, owner.job.execution))
            .for("update"),
          actual = row?.result as Record<string, unknown> | undefined,
          retained = actual?._configurationCandidate as Record<string, unknown> | undefined,
          remote = actual?._configurationMaintenance as Record<string, unknown> | undefined;
        if (
          !actual ||
          retained?.candidateId !== candidate.candidateId ||
          retained.revisionId !== candidate.revisionId ||
          retained.sealedOperationKey !== record.operationKey ||
          retained.maintenanceId !== record.maintenanceId ||
          retained.phase !== "save_attempted" ||
          retained.rowVersions !== undefined ||
          actual._configurationMaintenanceDecision !== undefined ||
          actual._configurationMaintenanceRollback !== undefined ||
          remote?.phase !== "prepared" ||
          canonicalJson(remote.receipt) !== canonicalJson(prepared) ||
          hasPendingReceiptDelivery(actual) ||
          hasUnsettledManagedOperation(actual)
        )
          throw new JobObservationPending("recovery_required");
        const proof = configurationMaintenanceRollbackCheckpointSchema.parse({
          version: 1,
          disposition: "known_rolled_back",
          rollbackId: randomUUID(),
          candidateId: candidate.candidateId,
          maintenanceId: record.maintenanceId,
          prepareOperationKey: record.prepareOperationKey,
          prepareFingerprint: prepared.prepare.operationFingerprint,
          planDigest: prepared.planDigest,
          checkpointVersion: owner.job.execution!.version,
        });
        rollbackCheckpoint = {
          ...actual,
          _configurationCandidate: { ...retained, phase: "rolled_back" },
          _configurationMaintenanceRollback: proof,
        };
        const saved = await tx
          .update(schema.adminJob)
          .set({ result: rollbackCheckpoint })
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .returning({ id: schema.adminJob.id });
        if (saved.length !== 1) throw new JobObservationPending("recovery_required");
      });
      if (!rollbackCheckpoint) throw new JobObservationPending("recovery_required");
      owner.job.checkpointResult = rollbackCheckpoint;
    }
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  if (!committed || !decision) throw new JobObservationPending("recovery_required");
  state.persisted = true;
  candidateStages.set(candidate, "committed");
  owner.job.checkpointResult = committed;
  return decision;
}

export async function persistAndApplyProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
  options: { coordinatorMode: CoordinatorMode; signal?: AbortSignal },
): Promise<ProspectiveConfigurationReceipt> {
  const state = validatedConfigurationCandidateState(candidate);
  const owner = administrativeConfigurationState(state.writer),
    stage = candidateStages.get(candidate);
  if (
    (stage !== "prepared" && stage !== "committed") ||
    options.coordinatorMode !== state.overlay.coordinatorMode ||
    owner.participant?.mode === "preview"
  )
    throw Error("Configuration candidate persistence refused");
  if (
    ["migration", "transit-credentials", "platform"].includes(state.overlay.purpose) &&
    !owner.participant &&
    !(
      ["transit-credentials", "platform"].includes(state.overlay.purpose) &&
      stage === "committed" &&
      recoveredCommittedCandidates.has(candidate)
    )
  )
    throw Error("Configuration commit participant unavailable");
  if (!state.record.maintenanceId && stage === "committed")
    return applyCommittedOrdinaryCandidate(candidate, options.signal);
  if (state.record.maintenanceId) {
    const maintenance = await configurationMaintenanceProtocol;
    let decision: ConfigurationMaintenanceDecision;
    try {
      decision = await commitProspectiveConfigurationMaintenance(candidate);
    } catch (error) {
      // A known original pre-root rejection has no remote reservation to
      // abandon. Prove nonissuance under the same row lock before deleting its
      // inert packet; unknown helper/root/save attempts stay pinned.
      if (
        candidateStages.get(candidate) === "prepared" &&
        rejectedUnissuedCandidates.has(candidate) &&
        owner.job.checkpointResult?._configurationMaintenance === undefined
      ) {
        await discardUnissuedMaintenanceCandidate(candidate);
        throw new AdminJobFailure("Configuration candidate preflight failed", {
          configuration: {
            outcome: "not_committed",
            reason: "conflict",
            cleanupFailed: false,
            publisherCleanupFailed: false,
            registryUpdateFailed: false,
          },
        });
      }
      const preparation =
        state.record.prepareOperationKey &&
        readProjection(owner.job.checkpointResult).operations[state.record.prepareOperationKey];
      if (
        candidateStages.get(candidate) === "prepared" &&
        preparation &&
        preparation.terminal &&
        preparation.receiptDelivery?.state === "confirmed" &&
        ["failed", "timed_out"].includes(preparation.receiptDelivery.terminalReceipt.state)
      ) {
        await completeNeverPreparedConfiguration(candidate);
        throw error;
      }
      if (
        !(error instanceof ConfigurationWriteRolledBack) ||
        candidateStages.get(candidate) !== "rolled_back"
      )
        throw error;
      const abandon = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
      await maintenance.decideConfigurationMaintenance(abandon);
      const observed = await maintenance.inspectConfigurationMaintenance({
        maintenanceId: state.record.maintenanceId,
        candidateId: candidate.candidateId,
      });
      await maintenance.settleConfigurationMaintenance({
        kind: "configurationMaintenance.settle",
        maintenanceId: observed.binding.maintenanceId,
        candidateId: candidate.candidateId,
        prepareOperationKey: observed.prepare.operationKey,
        prepareFingerprint: observed.prepare.operationFingerprint,
        planDigest: observed.planDigest,
        decisionId: abandon.decisionId,
        expectedSequence: observed.sequence,
        evidenceDigest: configurationMaintenanceSettleRequestDigest(observed),
      });
      await discardUnusedPreparedProspectiveConfiguration(candidate);
      const application: TrustedConfigurationApplyOutcome = {
        outcome: "not_committed",
        reason: "conflict",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      };
      await owner.job.checkpoint({
        ...owner.job.checkpointResult,
        configuration: application,
        _configurationOutcomes: {
          ...(owner.job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
          [candidate.operationKey]: application,
        },
      });
      return {
        candidateId: candidate.candidateId,
        revisionId: candidate.revisionId,
        saved: "conflict",
        application,
      };
    }
    const authorized = await maintenance.decideConfigurationMaintenance(decision),
      generation = configurationApplyResultSchema.parse(
        await maintenance.executeConfigurationMaintenanceStep(candidate, 0),
      );
    const contained = generation.outcome === "not_committed" && !generation.cleanupFailed;
    if (
      !contained &&
      (generation.outcome !== "committed" ||
        generation.revisionId !== candidate.revisionId ||
        generation.followUp !== "complete" ||
        generation.cleanupFailed)
    )
      throw new JobObservationPending("recovery_required");
    let registryUpdateFailed = false;
    if (generation.outcome === "committed")
      try {
        getServiceRegistry().applyEnabledIds(new Set(generation.enabledServiceIds));
      } catch {
        registryUpdateFailed = true;
      }
    if (!contained)
      for (const step of authorized.steps.slice(1))
        await maintenance.executeConfigurationMaintenanceStep(candidate, step.ordinal);
    const observed = await maintenance.inspectConfigurationMaintenance(authorized.binding);
    if (
      !observed.decision ||
      observed.decision.decisionId !== decision.decisionId ||
      (contained
        ? observed.generation !== "not_committed" ||
          observed.appliedRevisionId !== null ||
          observed.followUp !== "contained"
        : observed.generation !== "committed" ||
          observed.appliedRevisionId !== candidate.revisionId ||
          observed.followUp !== "complete")
    )
      throw new JobObservationPending("recovery_required");
    // Once admitted, the original request is immutable even when finalization
    // advanced the observed owner sequence. Recovery delivers/copies that
    // exact retained winner; it never derives a new checksum/body or key.
    const originalSettlement = owner.job.checkpointResult?._configurationMaintenanceSettle,
      settled = await maintenance.settleConfigurationMaintenance(
        originalSettlement === undefined
          ? {
              kind: "configurationMaintenance.settle",
              maintenanceId: observed.binding.maintenanceId,
              candidateId: candidate.candidateId,
              prepareOperationKey: observed.prepare.operationKey,
              prepareFingerprint: observed.prepare.operationFingerprint,
              planDigest: observed.planDigest,
              decisionId: observed.decision.decisionId,
              expectedSequence: observed.sequence,
              evidenceDigest: configurationMaintenanceSettleRequestDigest(observed),
            }
          : configurationMaintenanceSettleCheckpointSchema.parse(originalSettlement).operation,
      );
    if (
      contained
        ? settled.generation !== "not_committed" ||
          settled.appliedRevisionId !== null ||
          settled.followUp !== "contained"
        : settled.generation !== "committed" ||
          settled.appliedRevisionId !== candidate.revisionId ||
          settled.followUp !== "complete"
    )
      throw new JobObservationPending("recovery_required");
    const application: TrustedConfigurationApplyOutcome = {
        ...generation,
        publisherCleanupFailed: false,
        registryUpdateFailed,
      },
      checkpoint = owner.job.checkpointResult?._configurationCandidate as Record<string, unknown>,
      source = configurationMaintenanceDecisionCheckpointSchema.parse(
        owner.job.checkpointResult?._configurationMaintenanceDecision,
      ),
      serviceId = "serviceId" in state.sealed.operation ? state.sealed.operation.serviceId : null;
    await owner.job.checkpoint({
      ...owner.job.checkpointResult,
      _configurationCandidate: {
        ...checkpoint,
        phase: registryUpdateFailed ? "unknown" : "settled",
      },
      configuration: application,
      _configurationOutcomes: {
        ...(owner.job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: application,
      },
      ...(state.record.apiFollowUp === "service-apply" && serviceId
        ? {
            serviceCredential: {
              serviceId,
              revisionId: candidate.revisionId,
              followUp: contained ? "contained" : "complete",
            },
          }
        : {}),
      ...(state.record.privateCoordinatorLifecycle
        ? {
            coordinatorLifecycle: {
              serviceId: "data-manager",
              action: state.record.privateCoordinatorLifecycle.action,
              revisionId: candidate.revisionId,
              followUp: contained ? "contained" : "complete",
            },
          }
        : {}),
      ...(state.record.privatePlatformIntent
        ? {
            platformConfiguration: {
              previewFingerprint: state.record.privatePlatformIntent.previewFingerprint,
              handoffId: state.record.privatePlatformIntent.handoffId,
              revisionId: candidate.revisionId,
              followUp: contained ? "contained" : "complete",
            },
          }
        : {}),
    });
    if (!registryUpdateFailed) await retireSettledProspectiveConfiguration(candidate);
    return {
      candidateId: candidate.candidateId,
      revisionId: candidate.revisionId,
      saved: state.record.privateCoordinatorLifecycle
        ? "unchanged"
        : source.rowVersions.length
          ? "committed"
          : "unchanged",
      application,
    };
  }
  const checkpoint = candidateCheckpoint(candidate, state);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: checkpoint,
  });
  try {
    await verifyCurrentPreview(candidate, state, options.signal);
    await verifyConfigurationCommitParticipant(candidate, state.writer);
  } catch (error) {
    await discardUnadmittedTrustedConfigurationCandidate(candidate);
    candidateStages.set(candidate, "discarded");
    await owner.job.checkpoint({
      ...owner.job.checkpointResult,
      _configurationCandidate: { ...checkpoint, phase: "discarded" },
    });
    throw error;
  }
  let rowVersions: ConfigurationSavedRow[] = [];
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: { ...checkpoint, phase: "save_attempted" },
  });
  candidateStages.set(candidate, "save_attempted");
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx, context) => {
      if ((await sourceFingerprint(context, state.publisher.token)) !== candidate.sourceFingerprint)
        throw Error("Configuration source conflict");
      if (JSON.parse(state.sealed.bytes.toString()).expiresAt <= new Date().toISOString())
        throw Error("Configuration candidate expired");
      await verifyConfigurationCommitParticipant(candidate, state.writer);
      await verifyCurrentPreview(candidate, state, options.signal);
      await owner.participant?.commit(candidate, state.writer, tx);
      rowVersions = await persistOverlay(tx, state, candidate);
      const rows = await tx
        .update(schema.adminJob)
        .set({
          result: sql`coalesce(${schema.adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _configurationCandidate: { ...checkpoint, phase: "saved", rowVersions } })}::jsonb`,
        })
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .returning({ id: schema.adminJob.id });
      if (rows.length !== 1) throw Error("Configuration job ownership changed");
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteRolledBack) {
      candidateStages.set(candidate, "rolled_back");
      await discardUnadmittedTrustedConfigurationCandidate(candidate);
      candidateStages.set(candidate, "discarded");
      await owner.job.checkpoint({
        ...owner.job.checkpointResult,
        _configurationCandidate: { ...checkpoint, phase: "settled", saved: "conflict" },
      });
      return {
        candidateId: candidate.candidateId,
        revisionId: candidate.revisionId,
        saved: "conflict",
        application: {
          outcome: "not_committed",
          reason: "conflict",
          cleanupFailed: false,
          publisherCleanupFailed: false,
          registryUpdateFailed: false,
        },
      };
    }
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  state.persisted = true;
  candidateStages.set(candidate, "committed");
  owner.job.checkpointResult = {
    ...owner.job.checkpointResult,
    _configurationCandidate: { ...checkpoint, phase: "saved", rowVersions },
  };
  return applyCommittedOrdinaryCandidate(candidate, options.signal);
}
async function applyCommittedOrdinaryCandidate(
  candidate: ValidatedConfigurationCandidate,
  signal?: AbortSignal,
): Promise<ProspectiveConfigurationReceipt> {
  assertCommittedConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer);
  if (state.record.maintenanceId) throw Error("Ordinary candidate continuation required");
  let committed: Record<string, unknown> | undefined;
  const rowVersions = await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined;
    if (
      !result ||
      !["saved", "follow_up_pending"].includes(String(retained?.phase)) ||
      retained?.candidateId !== candidate.candidateId ||
      retained.revisionId !== candidate.revisionId ||
      retained.operationKey !== candidate.operationKey ||
      retained.sealedOperationKey !== state.record.operationKey
    )
      throw new JobObservationPending("recovery_required");
    const rows = z.array(configurationSavedRowSchema).max(512).parse(retained.rowVersions);
    await assertConfigurationSavedRows(tx, rows);
    if (state.overlay.purpose === "integration-binding")
      await assertSavedIntegrationBinding(candidate, state.overlay, tx);
    committed = result;
    return rows;
  });
  if (!committed) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = committed;
  signal?.throwIfAborted();
  const execute = () =>
    executeAdminJobOperation(owner.job, state.sealed.operation, "admin-job.configuration", {
      operationKey: candidate.operationKey,
      preparedRoot: {
        operationKey: state.record.operationKey,
        requestedDeadlineAt: parseControlRootOperationKey(state.record.operationKey).notAfter,
        parent: {
          operationKey: state.record.parentOperationKey,
          fingerprint: state.record.parentFingerprint,
          deadlineAt: state.record.parentDeadlineAt,
        },
      },
    });
  const attempted = readProjection(committed).operations[state.record.operationKey]?.attempt;
  const consumed = attempted
    ? { submission: { status: "fulfilled" as const, value: await execute() }, cleanupFailed: false }
    : await consumePublishedTrustedConfiguration(
        await publishPreparedTrustedConfigurationSnapshot(candidate),
        execute,
      );
  if (consumed.submission.status === "rejected") throw consumed.submission.reason;
  const result = consumed.submission.value as TrustedConfigurationApplyOutcome;
  let registryUpdateFailed = false;
  if (result.outcome === "committed") {
    try {
      getServiceRegistry().applyEnabledIds(new Set(result.enabledServiceIds));
    } catch {
      registryUpdateFailed = true;
    }
  }
  const application = {
    ...result,
    publisherCleanupFailed: consumed.cleanupFailed,
    registryUpdateFailed,
  };
  const phase =
    application.outcome === "unknown" ||
    application.publisherCleanupFailed ||
    application.registryUpdateFailed ||
    application.cleanupFailed
      ? "unknown"
      : application.outcome === "committed" &&
          state.record.apiFollowUp !== "none" &&
          application.followUp === "complete"
        ? "follow_up_pending"
        : "settled";
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(committed._configurationCandidate as Record<string, unknown>),
      phase,
      rowVersions,
    },
    configuration: application,
    _configurationOutcomes: {
      ...(owner.job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
      [candidate.operationKey]: application,
    },
  });
  if (phase === "settled" && completeTrustedConfigurationApply(application))
    await retireSettledProspectiveConfiguration(candidate);
  return {
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    saved: rowVersions.length ? "committed" : "unchanged",
    application,
  };
}

// Fixed nominal candidate publication and maintenance share this sole owner.
/** Consume the producer's exact seal, never reseal or rebuild after desired rows save. */
export async function publishPreparedTrustedConfigurationSnapshot(
  candidate: ValidatedConfigurationCandidate,
) {
  assertCommittedConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate);
  if (state.record.privatePlatformIntent)
    await verifyConfigurationCommitParticipant(candidate, state.writer);
  const inspected = inspectPreparedConfigurationRecord(
    encodePreparedConfigurationRecord(state.record, state.publisher.token),
    state.publisher.token,
  );
  if (inspected.snapshot.expiresAtMs <= Date.now()) throw new Error(REJECTED);
  return publishSnapshot(
    {
      ...state.publisher,
      operationKey: state.record.operationKey,
      operationForRevision: () => state.sealed.operation,
      payload: state.payload,
    },
    {},
    state.sealed,
  );
}

/** Fixed producer cleanup: an inert, unadmitted candidate cannot have a ready/claimed alias. */
export async function discardUnadmittedTrustedConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  assertUnadmittedConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate);
  return removeExactRetainedCandidate(candidate, state);
}
export async function retireSettledTrustedConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  await assertSettledConfigurationCandidate(candidate);
  return removeExactRetainedCandidate(candidate, validatedConfigurationCandidateState(candidate));
}
/** The fixed current producer's actual canonical completion authorizes only
 * retirement of its original inert packet, including an interrupted unlink.
 * The nominal handle is scoped to its live writer; raw IDs/flags cannot enter. */
export async function completeRetainedConfigurationRetirement(
  handle: RetainedConfigurationRetirement,
): Promise<void> {
  const state = retainedConfigurationRetirementState(handle),
    options = state.publisher,
    expected = state.checkpoint;
  if (
    typeof expected.sealedOperationKey !== "string" ||
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(expected.sealedOperationKey) ||
    typeof expected.revisionId !== "string" ||
    !/^cfg1_[A-Za-z0-9_-]{43}$/.test(expected.revisionId)
  )
    throw Error(REJECTED);
  await withPublicationLock(async () => {
    const queue = await acquireTrustedConfigurationQueueLock({
      ...options,
      participant: "api",
      operationKey: expected.sealedOperationKey as string,
    });
    try {
      for (const path of [
        join(options.directory, `${expected.revisionId}.json`),
        join(options.directory, ".claimed", `${expected.revisionId}.json`),
      ]) {
        try {
          await lstat(path);
          throw Error(REJECTED);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const directory = join(options.directory, ".candidates"),
        path = join(directory, `${expected.sealedOperationKey}.json`);
      await validateDirectory(directory, options.ownerUid, options.ownerGid);
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        queue.assertHeld();
        await syncDirectory(directory);
        return;
      }
      try {
        const before = await file.stat(),
          current = await lstat(path);
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.size > 768 * 1024 ||
          before.uid !== options.ownerUid ||
          before.gid !== options.ownerGid ||
          (before.mode & 0o777) !== SNAPSHOT_MODE ||
          before.dev !== current.dev ||
          before.ino !== current.ino
        )
          throw Error(REJECTED);
        const { record, snapshot } = inspectPreparedConfigurationRecord(
          await file.readFile(),
          options.token,
        );
        if (
          record.apiJobId !== state.apiJobId ||
          record.actorId !== state.actorId ||
          record.candidateId !== expected.candidateId ||
          record.operationKey !== expected.sealedOperationKey ||
          snapshot.revisionId !== expected.revisionId ||
          record.sourceFingerprint !== expected.sourceFingerprint ||
          record.maintenanceId !== expected.maintenanceId ||
          record.prepareOperationKey !== expected.prepareOperationKey
        )
          throw Error(REJECTED);
        retainedConfigurationRetirementState(handle);
        queue.assertHeld();
        const latest = await lstat(path);
        if (latest.dev !== before.dev || latest.ino !== before.ino) throw Error(REJECTED);
        await unlink(path);
        await syncDirectory(directory);
      } finally {
        await file.close();
      }
    } finally {
      queue.release();
    }
  });
}
async function removeExactRetainedCandidate(
  candidate: ValidatedConfigurationCandidate,
  state: ReturnType<typeof validatedConfigurationCandidateState>,
): Promise<void> {
  await withPublicationLock(async () => {
    const options = state.publisher;
    const queue = await acquireTrustedConfigurationQueueLock({
      ...options,
      participant: "api",
      operationKey: state.record.operationKey,
    });
    try {
      for (const path of [
        join(options.directory, `${candidate.revisionId}.json`),
        join(options.directory, ".claimed", `${candidate.revisionId}.json`),
      ]) {
        try {
          await lstat(path);
          throw new Error(REJECTED);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const directory = join(options.directory, ".candidates");
      await validateDirectory(directory, options.ownerUid, options.ownerGid);
      const path = join(directory, `${state.record.operationKey}.json`);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Both callers have already proved this nominal candidate unadmitted
        // or conclusively settled. Absence completes only its inert-file
        // deletion, never establishes an effect/guard outcome. Flush a prior
        // unlink whose acknowledgement or directory sync was interrupted.
        queue.assertHeld();
        await syncDirectory(directory);
        return;
      }
      try {
        const before = await handle.stat(),
          current = await lstat(path);
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== options.ownerUid ||
          before.gid !== options.ownerGid ||
          (before.mode & 0o777) !== SNAPSHOT_MODE ||
          before.dev !== current.dev ||
          before.ino !== current.ino ||
          !(await handle.readFile()).equals(
            encodePreparedConfigurationRecord(state.record, options.token),
          )
        )
          throw new Error(REJECTED);
        queue.assertHeld();
        const latest = await lstat(path);
        if (latest.dev !== before.dev || latest.ino !== before.ino) throw new Error(REJECTED);
        await unlink(path);
        await syncDirectory(directory);
      } finally {
        await handle.close();
      }
    } finally {
      queue.release();
    }
  });
}

/** Request correlation only: the receiver restores the SAME admitted root.
 * The original API parent deadline stays exact; only this fixed no-effect
 * metadata attempt receives its own bounded reconciliation clock. */
function prepareMaintenanceControlRequest(
  job: JobContext,
  operation: ConfigurationMaintenanceDecision | ConfigurationMaintenanceSettle,
  stepAddress: string,
) {
  if (operation.kind === "configurationMaintenance.decide" && operation.decision === "continue")
    return prepareApiJobRoot(job, operation.kind, stepAddress);
  const parent = z
    .strictObject({
      operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      deadlineAt: z.number().int().nonnegative().safe(),
    })
    .parse(job.checkpointResult?._parentExecution);
  if (!job.execution) throw Error("Original owned maintenance control required");
  const requestedDeadlineAt = Date.now() + 60000,
    nonce = createHash("sha256")
      .update("openmapx-api-control-root-nonce-v1\0")
      .update(canonicalJson({ jobId: job.jobId, stepAddress }))
      .digest()
      .subarray(0, 16);
  return {
    operationKey: createControlRootOperationKey({ notAfter: requestedDeadlineAt, nonce }),
    requestedDeadlineAt,
    parent,
  };
}
class MaintenanceUnsavedCheckpointConflict extends Error {
  constructor() {
    super("Original known-unsaved maintenance checkpoint required");
  }
}
function abandonCheckpointDigest(
  operation: Omit<ConfigurationMaintenanceDecision, "checkpointDigest">,
) {
  return configurationMaintenanceDbDecisionDigest(operation, []);
}

/** Retain only a known pre-save abandonment. The actual owned row lock waits
 * out an earlier transaction; a stale cache, timeout or missing desired row
 * cannot create it. This records the decision and issues NO host request/grant.
 * Delivery must consume the exact committed checkpoint, never this return
 * value as caller-supplied authorization. */
export async function prepareConfigurationMaintenanceAbandon(
  candidate: ValidatedConfigurationCandidate,
): Promise<ConfigurationMaintenanceDecision> {
  const source = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(source.writer),
    record = source.record;
  if (!record.maintenanceId || !record.prepareOperationKey || !owner.job.execution)
    throw new MaintenanceUnsavedCheckpointConflict();
  const prepared = await inspectConfigurationMaintenance({
    maintenanceId: record.maintenanceId,
    candidateId: candidate.candidateId,
  });
  if (
    prepared.state !== "prepared" ||
    prepared.decision !== null ||
    prepared.dmFence?.state !== "prepared" ||
    prepared.generation !== "not_started" ||
    prepared.followUp !== "not_started" ||
    prepared.appliedRevisionId !== null ||
    prepared.binding.applyOperationKey !== record.operationKey ||
    prepared.binding.applyOperationFingerprint !==
      opsOperationFingerprint(source.sealed.operation) ||
    prepared.binding.revisionId !== candidate.revisionId ||
    prepared.prepare.operationKey !== record.prepareOperationKey
  )
    throw new MaintenanceUnsavedCheckpointConflict();
  let committed: Record<string, unknown> | undefined,
    operation: ConfigurationMaintenanceDecision | undefined;
  try {
    await withConfigurationWriteTransaction(source.writer, async (tx) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined,
        maintenance = result?._configurationMaintenance as Record<string, unknown> | undefined,
        projected = readProjection(result).operations[record.prepareOperationKey!],
        delivery = projected?.receiptDelivery;
      if (retained?.phase === "rolled_back") {
        assertKnownRolledBackConfigurationCandidate(candidate);
        const rollback = configurationMaintenanceRollbackCheckpointSchema.parse(
          result?._configurationMaintenanceRollback,
        );
        if (
          rollback.candidateId !== candidate.candidateId ||
          rollback.maintenanceId !== record.maintenanceId ||
          rollback.prepareOperationKey !== record.prepareOperationKey ||
          rollback.prepareFingerprint !== prepared.prepare.operationFingerprint ||
          rollback.planDigest !== prepared.planDigest ||
          rollback.checkpointVersion > owner.job.execution!.version
        )
          throw new MaintenanceUnsavedCheckpointConflict();
      } else if (result?._configurationMaintenanceRollback !== undefined)
        throw new MaintenanceUnsavedCheckpointConflict();
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.operationKey !== candidate.operationKey ||
        retained.revisionId !== candidate.revisionId ||
        retained.sealedOperationKey !== record.operationKey ||
        retained.maintenanceId !== record.maintenanceId ||
        retained.prepareOperationKey !== record.prepareOperationKey ||
        !["prepared", "rolled_back"].includes(String(retained.phase)) ||
        retained.rowVersions !== undefined ||
        maintenance?.phase !== "prepared" ||
        maintenance.prepareOperationKey !== record.prepareOperationKey ||
        maintenance.prepareOperationFingerprint !== prepared.prepare.operationFingerprint ||
        !projected?.terminal ||
        projected.kind !== "configurationMaintenance.prepare" ||
        delivery?.state !== "confirmed" ||
        delivery.terminalReceipt.state !== "succeeded" ||
        canonicalJson(delivery.terminalReceipt.result) !== canonicalJson(maintenance.receipt) ||
        hasPendingReceiptDelivery(result) ||
        hasUnsettledManagedOperation(result) ||
        canonicalJson(result._parentExecution) !==
          canonicalJson({
            operationKey: record.parentOperationKey,
            fingerprint: record.parentFingerprint,
            deadlineAt: record.parentDeadlineAt,
          })
      )
        throw new MaintenanceUnsavedCheckpointConflict();
      const previous = result._configurationMaintenanceDecision;
      if (previous !== undefined) {
        const existing = abandonCheckpointSchema.parse(previous),
          { checkpointDigest, ...body } = existing.operation;
        if (
          body.decision !== "abandon" ||
          body.candidateId !== candidate.candidateId ||
          body.maintenanceId !== record.maintenanceId ||
          body.prepareOperationKey !== record.prepareOperationKey ||
          body.prepareFingerprint !== prepared.prepare.operationFingerprint ||
          body.planDigest !== prepared.planDigest ||
          body.expectedSequence !== prepared.sequence ||
          checkpointDigest !== abandonCheckpointDigest(body)
        )
          throw new MaintenanceUnsavedCheckpointConflict();
        committed = result;
        operation = existing.operation;
        return;
      }
      const body = {
        kind: "configurationMaintenance.decide" as const,
        maintenanceId: record.maintenanceId!,
        candidateId: candidate.candidateId,
        prepareOperationKey: record.prepareOperationKey!,
        prepareFingerprint: prepared.prepare.operationFingerprint,
        planDigest: prepared.planDigest,
        decisionId: randomUUID(),
        decision: "abandon" as const,
        expectedSequence: prepared.sequence,
        checkpointVersion: owner.job.execution!.version,
      };
      operation = configurationMaintenanceDecisionSchema.parse({
        ...body,
        checkpointDigest: abandonCheckpointDigest(body),
      });
      const checkpoint = abandonCheckpointSchema.parse({
        version: 1,
        operation,
        rowVersions: [],
        attempt: "not_attempted",
      });
      committed = { ...result, _configurationMaintenanceDecision: checkpoint };
      const saved = await tx
        .update(schema.adminJob)
        .set({ result: committed })
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .returning({ id: schema.adminJob.id });
      if (saved.length !== 1) throw new MaintenanceUnsavedCheckpointConflict();
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    if (
      error instanceof ConfigurationWriteRolledBack &&
      error.failure instanceof MaintenanceUnsavedCheckpointConflict
    )
      throw error.failure;
    throw error;
  }
  if (!committed || !operation) throw new JobObservationPending("recovery_required");
  owner.job.checkpointResult = committed;
  return operation;
}

/** Deliver the actual committed checkpoint, not a caller decision/digest. Its
 * one stable API step consumes the existing64-step capacity; the host binds the
 * request to the ORIGINAL owner rather than admitting a new physical root. */
export async function decideConfigurationMaintenance(
  decision: ConfigurationMaintenanceDecision,
): Promise<ConfigurationMaintenanceReceipt> {
  const expected = configurationMaintenanceDecisionSchema.parse(decision),
    exact = configurationMaintenanceIdentitySchema.parse({
      maintenanceId: expected.maintenanceId,
      candidateId: expected.candidateId,
      prepareOperationKey: expected.prepareOperationKey,
      prepareFingerprint: expected.prepareFingerprint,
      planDigest: expected.planDigest,
    }),
    owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner;
  let committed: Record<string, unknown> | undefined,
    retained: z.infer<typeof abandonCheckpointSchema> | undefined;
  try {
    await withConfigurationWriteTransaction(owner.writer, async (tx) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(job.jobId, job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined;
      if (!result) throw new MaintenanceUnsavedCheckpointConflict();
      const source = abandonCheckpointSchema.parse(result._configurationMaintenanceDecision),
        operation = source.operation,
        { checkpointDigest, ...body } = operation;
      if (
        canonicalJson(operation) !== canonicalJson(expected) ||
        checkpointDigest !== configurationMaintenanceDbDecisionDigest(body, source.rowVersions) ||
        canonicalJson({
          maintenanceId: operation.maintenanceId,
          candidateId: operation.candidateId,
          prepareOperationKey: operation.prepareOperationKey,
          prepareFingerprint: operation.prepareFingerprint,
          planDigest: operation.planDigest,
        }) !== canonicalJson(exact)
      )
        throw new MaintenanceUnsavedCheckpointConflict();
      if (operation.decision === "continue") {
        const candidate = result._configurationCandidate as Record<string, unknown> | undefined;
        if (
          candidate?.candidateId !== exact.candidateId ||
          candidate.maintenanceId !== exact.maintenanceId ||
          candidate.prepareOperationKey !== exact.prepareOperationKey ||
          !["saved", "applying", "follow_up_pending", "settling", "settled"].includes(
            String(candidate.phase),
          ) ||
          canonicalJson(candidate.rowVersions) !== canonicalJson(source.rowVersions)
        )
          throw new MaintenanceUnsavedCheckpointConflict();
        await assertConfigurationSavedRows(tx, source.rowVersions);
      }
      const maintenance = result._configurationMaintenance as Record<string, unknown> | undefined,
        prepared = configurationMaintenanceReceiptSchema.parse(maintenance?.receipt);
      if (
        prepared.prepare.operationKey !== exact.prepareOperationKey ||
        prepared.prepare.operationFingerprint !== exact.prepareFingerprint ||
        prepared.binding.maintenanceId !== exact.maintenanceId ||
        prepared.binding.candidateId !== exact.candidateId ||
        prepared.planDigest !== exact.planDigest
      )
        throw new MaintenanceUnsavedCheckpointConflict();
      if (source.delivery) {
        retained = source;
        committed = result;
        return;
      }
      if (source.attempt !== "not_attempted" || maintenance?.phase !== "prepared")
        throw new MaintenanceUnsavedCheckpointConflict();
      const stepAddress = createDurableOpsKey(
          "configuration-maintenance.decide",
          `${job.jobId}:${exact.candidateId}`,
        ),
        root = prepareMaintenanceControlRequest(
          { ...job, checkpointResult: result },
          source.operation,
          stepAddress,
        );
      retained = abandonCheckpointSchema.parse({ ...source, delivery: { stepAddress, root } });
      committed = { ...result, _configurationMaintenanceDecision: retained };
      const saved = await tx
        .update(schema.adminJob)
        .set({ result: committed })
        .where(jobOwnership(job.jobId, job.execution))
        .returning({ id: schema.adminJob.id });
      if (saved.length !== 1) throw new MaintenanceUnsavedCheckpointConflict();
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    if (
      error instanceof ConfigurationWriteRolledBack &&
      error.failure instanceof MaintenanceUnsavedCheckpointConflict
    )
      throw error.failure;
    throw error;
  }
  if (!committed || !retained?.delivery) throw new JobObservationPending("recovery_required");
  job.checkpointResult = committed;
  const source = retained,
    receipt = configurationMaintenanceReceiptSchema.parse(
      await executeAdminJobOperation(job, source.operation, "configuration-maintenance.decide", {
        operationKey: source.delivery!.stepAddress,
        preparedRoot: source.delivery!.root,
      }),
    );
  if (
    receipt.binding.maintenanceId !== exact.maintenanceId ||
    receipt.binding.candidateId !== exact.candidateId ||
    receipt.prepare.operationKey !== exact.prepareOperationKey ||
    receipt.prepare.operationFingerprint !== exact.prepareFingerprint ||
    receipt.planDigest !== exact.planDigest ||
    receipt.decision?.decisionId !== source.operation.decisionId ||
    receipt.decision.decision !== source.operation.decision ||
    receipt.decision.checkpointVersion !== source.operation.checkpointVersion ||
    receipt.decision.checkpointDigest !== source.operation.checkpointDigest
  )
    throw new JobObservationPending("invalid_identity");
  const latest = job.checkpointResult?._configurationMaintenance as Record<string, unknown>;
  if (!["settling", "settled"].includes(String(latest.phase)))
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: {
        ...latest,
        phase: "authorized",
        decision: source.operation,
        receipt,
      },
    });
  return receipt;
}

/** API-only coordinator for ONE frozen phase. The body/address comes from the
 * actual committed job/decision, never a browser plan or preparedRoot recipe.
 * An attempted phase is lookup-only and never republishes the sealed claim. */
export async function executeConfigurationMaintenanceStep(
  candidate: ValidatedConfigurationCandidate,
  ordinal: number,
): Promise<unknown> {
  assertCommittedConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer);
  if (!state.record.maintenanceId) throw Error("Original maintenance candidate required");
  const prepared = await prepareOwnedConfigurationMaintenanceStep(
      ordinal,
      candidate.candidateId,
      state.record.maintenanceId,
    ),
    execute = () =>
      executeAdminJobOperation(job, prepared.step.operation, "configuration-maintenance.step", {
        operationKey: prepared.step.operationKey,
        preparedRoot: prepared.root,
      });
  if (
    prepared.step.phase !== "configuration-commit" ||
    readProjection(job.checkpointResult).operations[prepared.step.operationKey]
  )
    return execute();
  const published = await publishPreparedTrustedConfigurationSnapshot(candidate),
    consumed = await consumePublishedTrustedConfiguration(published, execute);
  if (consumed.submission.status === "rejected") throw consumed.submission.reason;
  if (consumed.cleanupFailed) throw new JobObservationPending("recovery_required");
  return consumed.submission.value;
}

/** Retain the exact API-observed request before HMAC/POST. An attempted winner
 * observes its original body after later owner sequences, never rekeys. */
export async function settleConfigurationMaintenance(
  request: ConfigurationMaintenanceSettle,
): Promise<ConfigurationMaintenanceReceipt> {
  const exact = configurationMaintenanceSettleSchema.parse(request),
    owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner;
  if (owner.transactionActive || !job.execution)
    throw Error("Original settlement job writer required");
  const prior = job.checkpointResult?._configurationMaintenanceSettle;
  let observed: ConfigurationMaintenanceReceipt | undefined;
  if (prior === undefined) {
    observed = await inspectConfigurationMaintenance(exact);
    if (
      observed.decision?.decisionId !== exact.decisionId ||
      observed.sequence !== exact.expectedSequence ||
      observed.prepare.operationKey !== exact.prepareOperationKey ||
      observed.prepare.operationFingerprint !== exact.prepareFingerprint ||
      observed.planDigest !== exact.planDigest ||
      configurationMaintenanceSettleRequestDigest(observed) !== exact.evidenceDigest
    )
      throw Error("Actual API settlement observation conflict");
  }
  let committed: Record<string, unknown> | undefined;
  const retained = await withConfigurationWriteTransaction(owner.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result })
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      maintenance = result?._configurationMaintenance as Record<string, unknown> | undefined,
      decision = abandonCheckpointSchema.parse(result?._configurationMaintenanceDecision);
    if (
      !result ||
      maintenance?.candidateId !== exact.candidateId ||
      maintenance.maintenanceId !== exact.maintenanceId ||
      maintenance.prepareOperationKey !== exact.prepareOperationKey ||
      maintenance.prepareOperationFingerprint !== exact.prepareFingerprint ||
      decision.operation.decisionId !== exact.decisionId ||
      decision.operation.planDigest !== exact.planDigest ||
      decision.attempt !== "attempted"
    )
      throw Error("Actual original settlement checkpoint required");
    if (result._configurationMaintenanceSettle !== undefined) {
      const original = configurationMaintenanceSettleCheckpointSchema.parse(
        result._configurationMaintenanceSettle,
      );
      if (canonicalJson(original.operation) !== canonicalJson(exact))
        throw Error("Original accepted settlement request changed");
      committed = result;
      return original;
    }
    if (
      !observed ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result) ||
      !decision.delivery
    )
      throw new JobObservationPending("recovery_required");
    const delivered =
      readProjection(result).operations[decision.delivery.root.operationKey]?.receiptDelivery;
    if (
      delivered?.state !== "confirmed" ||
      delivered.terminalReceipt.state !== "succeeded" ||
      configurationMaintenanceReceiptSchema.parse(delivered.terminalReceipt.result).decision
        ?.decisionId !== exact.decisionId
    )
      throw Error("Original delivered decision required");
    const stepAddress = createDurableOpsKey(
        "configuration-maintenance.settle",
        `${job.jobId}:${exact.candidateId}`,
      ),
      checkpoint = configurationMaintenanceSettleCheckpointSchema.parse({
        version: 1,
        operation: exact,
        attempt: "not_attempted",
        delivery: {
          stepAddress,
          root: prepareMaintenanceControlRequest(
            { ...job, checkpointResult: result },
            exact,
            stepAddress,
          ),
        },
      });
    committed = { ...result, _configurationMaintenanceSettle: checkpoint };
    const saved = await tx
      .update(schema.adminJob)
      .set({ result: committed })
      .where(jobOwnership(job.jobId, job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
    return checkpoint;
  });
  if (!committed) throw new JobObservationPending("recovery_required");
  job.checkpointResult = committed;
  const receipt = configurationMaintenanceReceiptSchema.parse(
    await executeAdminJobOperation(job, retained.operation, "configuration-maintenance.settle", {
      operationKey: retained.delivery.stepAddress,
      preparedRoot: retained.delivery.root,
    }),
  );
  if (
    receipt.binding.maintenanceId !== exact.maintenanceId ||
    receipt.binding.candidateId !== exact.candidateId ||
    receipt.prepare.operationKey !== exact.prepareOperationKey ||
    receipt.prepare.operationFingerprint !== exact.prepareFingerprint ||
    receipt.planDigest !== exact.planDigest ||
    receipt.decision?.decisionId !== exact.decisionId ||
    receipt.state !== "settled" ||
    receipt.dmFence?.state !== "settled"
  )
    throw new JobObservationPending("invalid_identity");
  const latest = job.checkpointResult?._configurationMaintenance as Record<string, unknown>;
  await job.checkpoint({
    ...job.checkpointResult,
    _configurationMaintenance: { ...latest, phase: "settled", receipt },
  });
  return receipt;
}

export async function prepareConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<ConfigurationMaintenanceReceipt> {
  const source = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(source.writer),
    record = source.record,
    apply = source.sealed.operation;
  if (
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    !("expectedSourceRevision" in apply) ||
    !("coordinatorMode" in apply)
  )
    throw Error("Actual maintenance-bound candidate required");
  const operation = configurationMaintenancePrepareSchema.parse({
    kind: "configurationMaintenance.prepare",
    maintenanceId: record.maintenanceId,
    candidateId: record.candidateId,
    applyOperationKey: record.operationKey,
    applyOperationFingerprint: opsOperationFingerprint(apply),
    expectedCurrentRevisionId: candidate.expectedCurrentRevisionId,
    revisionId: candidate.revisionId,
    expectedSourceRevision: record.expectedSourceRevision,
    coordinatorMode: source.overlay.coordinatorMode,
    followUp: record.privatePlatformIntent
      ? "platform-apply"
      : record.apiFollowUp === "service-apply" || record.privateCoordinatorLifecycle
        ? "service-apply"
        : "render-only",
  });
  const checkpoint = {
    maintenanceId: record.maintenanceId,
    candidateId: record.candidateId,
    prepareOperationKey: record.prepareOperationKey,
    prepareOperationFingerprint: opsOperationFingerprint(operation),
    operation,
    phase: "preparing",
  };
  const retained = job.checkpointResult?._configurationMaintenance as
    | Record<string, unknown>
    | undefined;
  if (
    retained &&
    (retained.prepareOperationKey !== checkpoint.prepareOperationKey ||
      retained.prepareOperationFingerprint !== checkpoint.prepareOperationFingerprint ||
      retained.candidateId !== checkpoint.candidateId)
  )
    throw Error("Original maintenance attempt changed");
  // An attempted root is lookup-only. Its replay never reruns preparation,
  // helper admission or candidate validation against a newer desired state.
  if (!readProjection(job.checkpointResult).operations[record.prepareOperationKey]?.attempt)
    await stageProspectiveConfigurationMaintenance(candidate, job.signal);
  if (!retained)
    await job.checkpoint({ ...job.checkpointResult, _configurationMaintenance: checkpoint });
  const receipt = configurationMaintenanceReceiptSchema.parse(
    await executeAdminJobOperation(job, operation, "configuration-maintenance.prepare", {
      operationKey: createDurableOpsKey(
        "configuration-maintenance.prepare",
        `${job.jobId}:${candidate.candidateId}`,
      ),
      preparedRoot: {
        operationKey: record.prepareOperationKey,
        requestedDeadlineAt: parseControlRootOperationKey(record.prepareOperationKey).notAfter,
        parent: {
          operationKey: record.parentOperationKey,
          fingerprint: record.parentFingerprint,
          deadlineAt: record.parentDeadlineAt,
        },
      },
    }),
  );
  if (
    receipt.binding.maintenanceId !== record.maintenanceId ||
    receipt.binding.candidateId !== candidate.candidateId ||
    receipt.binding.applyOperationKey !== record.operationKey ||
    receipt.binding.applyOperationFingerprint !== operation.applyOperationFingerprint ||
    receipt.prepare.operationKey !== record.prepareOperationKey ||
    receipt.prepare.operationFingerprint !== checkpoint.prepareOperationFingerprint ||
    receipt.apiJobId !== job.jobId ||
    receipt.parentOperationKey !== record.parentOperationKey ||
    receipt.parentFingerprint !== record.parentFingerprint ||
    receipt.parentDeadlineAt !== record.parentDeadlineAt ||
    receipt.state !== "prepared" ||
    receipt.preflight !== "current"
  )
    throw Error("Original prepared maintenance receipt required");
  const latest = job.checkpointResult?._configurationMaintenance as
    | Record<string, unknown>
    | undefined;
  if (!["authorized", "applying", "settling", "settled"].includes(String(latest?.phase)))
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: { ...checkpoint, phase: "prepared", receipt },
    });
  return receipt;
}
type MaintenanceInspectionCheckpoint =
  | { attempt: ApiJobChildAttempt; state: "attempted" }
  | { attempt: ApiJobChildAttempt; state: "complete"; receipt: ConfigurationMaintenanceReceipt };
/** An inspection inside the final desired-write transaction uses THAT owned
 * connection. It never waits on its own row through the generic checkpoint
 * pool, changes the caller's committed cache or acknowledges mutation evidence
 * from an uncommitted transaction. The host request itself is read-only. */
async function checkpointMaintenanceInspection(
  retained: Record<string, unknown>,
  inspection: MaintenanceInspectionCheckpoint,
  transaction: AdministrativeConfigurationReadContext | null,
): Promise<void> {
  const owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner;
  if (transaction === null) {
    if (owner.transactionActive) throw Error("Maintenance inspection ownership changed");
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: { ...retained, inspection },
    });
    return;
  }
  if (
    !owner.transactionActive ||
    owner.transactionMode !== "write" ||
    owner.transactionContext !== transaction
  )
    throw Error("Actual original owned write inspection transaction required");
  assertAdministrativeConfigurationRead(owner.transactionContext);
  const [row] = await owner.connection
      .select({ result: schema.adminJob.result })
      .from(schema.adminJob)
      .where(jobOwnership(job.jobId, job.execution))
      .for("update"),
    result = row?.result as Record<string, unknown> | undefined,
    actual = result?._configurationMaintenance as Record<string, unknown> | undefined,
    attempt = inspection.attempt;
  if (
    !result ||
    !actual ||
    actual.maintenanceId !== retained.maintenanceId ||
    actual.candidateId !== retained.candidateId ||
    actual.prepareOperationKey !== retained.prepareOperationKey ||
    actual.prepareOperationFingerprint !== retained.prepareOperationFingerprint ||
    canonicalJson(actual.operation) !== canonicalJson(retained.operation) ||
    attempt.apiJobId !== job.jobId ||
    attempt.apiOwnerVersion !== job.execution?.version ||
    canonicalJson(result._parentExecution) !==
      canonicalJson({
        operationKey: attempt.parentOperationKey,
        fingerprint: attempt.parentFingerprint,
        deadlineAt: attempt.parentDeadlineAt,
      })
  )
    throw Error("Original owned maintenance inspection checkpoint required");
  const rows = await owner.connection
    .update(schema.adminJob)
    .set({ result: { ...result, _configurationMaintenance: { ...actual, inspection } } })
    .where(jobOwnership(job.jobId, job.execution))
    .returning({ id: schema.adminJob.id });
  if (rows.length !== 1) throw Error("Original maintenance inspection ownership changed");
}
/** Each inspection is a bounded authenticated read of the ORIGINAL owner. It
 * never reuses a cached sync result, renews the seal/root or authorizes effects. */
export async function inspectConfigurationMaintenance(
  identity: Pick<ConfigurationMaintenanceIdentity, "maintenanceId" | "candidateId">,
): Promise<ConfigurationMaintenanceReceipt> {
  const owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner,
    transaction = owner.transactionActive ? owner.transactionContext : null,
    retained = job.checkpointResult?._configurationMaintenance as
      | Record<string, unknown>
      | undefined,
    prepared = configurationMaintenancePrepareSchema.parse(retained?.operation);
  if (transaction === undefined)
    throw Error("Actual original maintenance inspection scope required");
  if (
    !job.execution ||
    prepared.maintenanceId !== identity.maintenanceId ||
    prepared.candidateId !== identity.candidateId ||
    typeof retained?.prepareOperationKey !== "string" ||
    retained.prepareOperationFingerprint !== opsOperationFingerprint(prepared)
  )
    throw Error("Original retained maintenance inspection required");
  const parent = z
      .strictObject({
        operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        deadlineAt: z.number().int().nonnegative().safe(),
      })
      .parse(job.checkpointResult?._parentExecution),
    operation = {
      kind: "configurationMaintenance.inspect" as const,
      maintenanceId: prepared.maintenanceId,
      candidateId: prepared.candidateId,
    },
    key = createDurableOpsKey(
      "configuration-maintenance.inspect",
      `${job.jobId}:${retained.prepareOperationKey}:${prepared.candidateId}`,
    ),
    attempt = prepareApiJobChildAttempt(job, operation, key, {
      operationKey: key,
      parent,
      requestedDeadlineAt: Date.now() + 15000,
    });
  if (!attempt) throw Error("Original live API inspection owner required");
  await checkpointMaintenanceInspection(retained, { attempt, state: "attempted" }, transaction);
  const response = await createApiOpsClient().execute(operation, {
    operationKey: key,
    signal: AbortSignal.any([job.signal, AbortSignal.timeout(15000)]),
    execution: { requestedDeadlineAt: attempt.requestedDeadlineAt },
    parentAssertion: await issueApiJobChildAssertion(attempt),
  });
  if (response.execution !== "sync") throw Error("Original maintenance inspection unavailable");
  const receipt = configurationMaintenanceReceiptSchema.parse(response.value),
    { kind: _kind, ...binding } = prepared;
  if (
    JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
    receipt.prepare.operationKey !== retained.prepareOperationKey ||
    receipt.prepare.operationFingerprint !== retained.prepareOperationFingerprint ||
    receipt.apiJobId !== job.jobId ||
    receipt.parentOperationKey !== parent.operationKey ||
    receipt.parentFingerprint !== parent.fingerprint ||
    receipt.parentDeadlineAt !== parent.deadlineAt
  )
    throw Error("Original maintenance inspection identity changed");
  const latest = job.checkpointResult?._configurationMaintenance as Record<string, unknown>;
  await checkpointMaintenanceInspection(
    latest,
    { attempt, state: "complete", receipt },
    transaction,
  );
  // Only the fixed host inspector's full, released NoGuard proof can resolve a
  // historical unknown preparation. Deliver its ORIGINAL canonical failure;
  // neither that failure's classification nor its immutable bytes are changed.
  if (
    receipt.state === "settled" &&
    receipt.dmFence === null &&
    receipt.decision === null &&
    receipt.generation === "not_started" &&
    receipt.followUp === "not_started"
  ) {
    if (
      administrativeConfigurationState(currentAdministrativeConfigurationWriter()).transactionActive
    )
      throw new JobObservationPending("receipt_delivery");
    const projection = readProjection(job.checkpointResult),
      projected = projection.operations[receipt.prepare.operationKey];
    if (
      !projected?.attempt ||
      projected.kind !== "configurationMaintenance.prepare" ||
      !projected.operation ||
      opsOperationFingerprint(projected.operation) !== receipt.prepare.operationFingerprint ||
      projected.operationId !== receipt.prepare.executionId ||
      projected.fingerprint !== receipt.prepare.fingerprint ||
      projected.deadlineAt !== receipt.prepare.deadlineAt ||
      projected.attempt.apiJobId !== receipt.apiJobId ||
      projected.attempt.parentOperationKey !== receipt.parentOperationKey ||
      projected.attempt.parentFingerprint !== receipt.parentFingerprint ||
      projected.attempt.parentDeadlineAt !== receipt.parentDeadlineAt
    )
      throw Error("Original closed maintenance preparation required");
    const client = createApiOpsClient(),
      status = await client.status(projected.kind, projected.operationId, {
        signal: AbortSignal.timeout(15000),
      });
    if (
      (status.state !== "failed" && status.state !== "timed_out") ||
      status.kind !== projected.kind ||
      status.operationId !== projected.operationId ||
      status.operationKey !== projected.operationKey ||
      status.fingerprint !== projected.fingerprint ||
      status.deadlineAt !== projected.deadlineAt
    )
      throw Error("Original closed maintenance canonical failure required");
    projected.phase = "terminal";
    projected.terminal = true;
    projected.errorClass = status.errorClass;
    projected.failureResult = status.failureResult;
    delete projected.outcome;
    await ensureAdminJobReceiptDelivery(job, projection, projected, client, status);
    if (projected.receiptDelivery?.state !== "confirmed")
      throw Error("Original closed maintenance receipt delivery unavailable");
  }
  return receipt;
}

const configurationMaintenanceProtocol = Object.freeze({
  prepareConfigurationMaintenanceAbandon,
  decideConfigurationMaintenance,
  executeConfigurationMaintenanceStep,
  settleConfigurationMaintenance,
  prepareConfigurationMaintenance,
  inspectConfigurationMaintenance,
});

/** Observation-only after an interrupted attempt; never replay unknown setup. */
export async function completeIntegrationActivation(
  candidate: ValidatedConfigurationCandidate,
  hostApply: IntegrationApplyReceipt["hostApply"],
): Promise<IntegrationApplyReceipt> {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    change = state.overlay.changes[0];
  const binding = state.overlay.purpose === "integration-binding";
  if (
    state.overlay.changes.length !== 1 ||
    !change ||
    !(
      (binding && change.kind === "integration-binding") ||
      (state.overlay.purpose === "integration-secret" &&
        change.kind === "integration-secret" &&
        change.expectedRevision)
    )
  )
    throw Error("Original integration candidate required");
  const retained = state.record.privateIntegrationReload,
    retainedManifest = retained?.integrations.find((i) => i.id === change.integrationId)?.manifest,
    values = retained?.values[change.integrationId];
  const manifest = getIntegration(change.integrationId)?.manifest,
    loadedServices = getServiceRegistry().list();
  if (
    !retained?.bindings ||
    !manifest ||
    !values ||
    canonicalJson(manifest) !== canonicalJson(retainedManifest) ||
    canonicalJson(loadedServices) !== canonicalJson(retained.services)
  )
    throw new JobObservationPending("recovery_required");
  const config = Object.fromEntries(
    Object.entries(values).map(([key, entry]) => [key, entry.value]),
  );
  const resolved = resolveRequiresForIntegration({
    manifestId: change.integrationId,
    requires: manifest.requires,
    loadedServices,
    bindings: new Map(Object.entries(retained.bindings[change.integrationId] ?? {})),
  });
  const expected = Object.fromEntries(
    (manifest.requires ?? []).map((req) => {
      const key = req.capability ?? req.service!;
      return [key, resolved.get(key)?.serviceId ?? null];
    }),
  );
  const matches = () => {
    const live = inspectIntegrationRuntime(change.integrationId);
    return live &&
      live.configRevision === integrationConfigRevision(config) &&
      canonicalJson(live.bindings) === canonicalJson(expected)
      ? live
      : null;
  };
  let receipt: IntegrationApplyReceipt = binding
    ? await withConfigurationWriteTransaction(
        state.writer,
        async (tx) => (await assertSavedIntegrationBinding(candidate, state.overlay, tx)).result,
      )
    : integrationApplyReceiptSchema.parse(
        job.checkpointResult?.integrationApplication ?? {
          operationId: candidate.operationKey,
          integrationId: change.integrationId,
          desiredRevision: await withAdministrativeConfigurationRead(
            {},
            async (read) =>
              (await integrationOwnershipSnapshot(change.integrationId, read)).revision,
          ),
          database: "retained",
          runtime: "pending",
          runtimeGenerationId: null,
        },
      );
  if (
    receipt.operationId !== candidate.operationKey ||
    receipt.integrationId !== change.integrationId
  )
    throw new JobObservationPending("recovery_required");
  async function saveReceipt(next: IntegrationApplyReceipt) {
    if (binding)
      await withConfigurationWriteTransaction(state.writer, async (tx) => {
        await assertSavedIntegrationBinding(candidate, state.overlay, tx);
        await tx
          .update(integrationApplicationReceipt)
          .set({ result: next })
          .where(
            and(
              eq(integrationApplicationReceipt.operationId, candidate.operationKey),
              eq(integrationApplicationReceipt.candidateId, candidate.candidateId),
            ),
          );
      });
    else await job.checkpoint({ ...job.checkpointResult, integrationApplication: next });
  }
  const original = job.checkpointResult?.integrationReload as Record<string, unknown> | undefined;
  if (original?.candidateId && original.candidateId !== candidate.candidateId)
    throw new JobObservationPending("recovery_required");
  if (original?.state !== "complete") {
    const before = inspectIntegrationRuntime(change.integrationId);
    let failed = false;
    if (!original) {
      if (!binding) await saveReceipt(receipt);
      await job.checkpoint({
        ...job.checkpointResult,
        integrationReload: {
          state: "attempted",
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
        },
      });
      try {
        await reloadProspectiveIntegrations(candidate);
      } catch {
        failed = true;
      }
    }
    let sourceCurrent = true;
    try {
      await assertCurrentIntegrationReloadSources(candidate);
    } catch {
      sourceCurrent = false;
    }
    const live = sourceCurrent ? matches() : null,
      disabled =
        sourceCurrent &&
        config.enabled === false &&
        getIntegration(change.integrationId)?.enabled === false;
    if (live)
      receipt = {
        ...receipt,
        runtime: "applied",
        runtimeGenerationId: live.generationId,
        reason: undefined,
      };
    else if (disabled)
      receipt = {
        ...receipt,
        runtime: "pending",
        runtimeGenerationId: null,
        reason: "integration_disabled",
      };
    else if (
      failed &&
      before &&
      inspectIntegrationRuntime(change.integrationId)?.generationId === before.generationId
    )
      receipt = {
        ...receipt,
        runtime: "failed",
        runtimeGenerationId: before.generationId,
        reason: "reload_failed",
      };
    else {
      await saveReceipt({
        ...receipt,
        runtime: "unknown",
        reason: "reconciliation_required",
        hostApply,
      });
      throw new JobObservationPending("recovery_required");
    }
    receipt = integrationApplyReceiptSchema.parse({ ...receipt, hostApply });
    await saveReceipt(receipt);
    await job.checkpoint({
      ...job.checkpointResult,
      [binding ? "integrationBinding" : "integrationApplication"]: receipt,
      _configurationCandidate: {
        ...(job.checkpointResult?._configurationCandidate as Record<string, unknown>),
        phase: "settled",
      },
      integrationReload: {
        state: "complete",
        candidateId: candidate.candidateId,
        revisionId: candidate.revisionId,
        result: {
          message: "Binding activation observed",
          reloaded: receipt.runtime === "applied" ? 1 : 0,
          enabled: getIntegration(change.integrationId)?.enabled ? 1 : 0,
        },
      },
    });
  }
  await retireSettledProspectiveConfiguration(candidate);
  return integrationApplyReceiptSchema.parse(receipt);
}

/** Fixed managed-key dispatch over THIS producer's nominal candidate, inside its original transaction. */
export async function persistPreparedFeedCredentialPatch(input: {
  patch: import("./transit-feed-credential-participant").PreparedFeedCredentialPatch;
  candidate: ValidatedConfigurationCandidate;
  writer: AdministrativeConfigurationWriter;
}): Promise<{ credentialsRevision: string }> {
  const state = validatedConfigurationCandidateState(input.candidate);
  if (state.writer !== input.writer) throw Error("Original transit credential candidate required");
  const { persistPreparedFeedCredentialRow } = await import(
    "./transit-feed-credential-participant"
  );
  return persistPreparedFeedCredentialRow({ ...input, candidateState: state });
}
