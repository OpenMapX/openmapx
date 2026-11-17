import { createHash, randomUUID } from "node:crypto";
import {
  type IntegrationApplyReceipt,
  integrationApplyReceiptSchema,
} from "@openmapx/core/api-contracts";
import { controlChildOperationKey } from "@openmapx/core/build-artifacts";
import {
  type ConfigurationHardlinksPreview,
  type ConfigurationMaintenancePrepare,
  type ConfigurationSourcesInspection,
  type CoordinatorMode,
  canonicalJson,
  configurationApplyResultSchema,
  configurationHardlinksPreviewSchema,
  configurationMaintenancePrepareSchema,
  coordinatorModeSchema,
  createControlRootOperationKey,
  type MaintenanceRecord,
  maintenanceRecordSchema,
  OPS_MAX_REQUEST_TTL_MS,
  OpsClientError,
  type OpsOperation,
  type OpsResultFor,
  opsOperationFingerprint,
  opsOperationSchema,
  type PreparedConfigurationRecord,
  parseControlRootOperationKey,
  prepareConfigurationCandidate,
  protectedConfigurationServiceIdSchema,
  readOpsTokenFile,
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import { integrationApplicationReceipt } from "../db/schema";
import { resolveIntegrationConfigWithSourcesStrict } from "../integration-config";
import { getIntegration, inspectIntegrationRuntime } from "../integration-host";
import { apiKeyedDigest } from "./admin-job-digest";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  deliverCoordinatorPullSubmission,
  executeAdminJobOperation,
  prepareAdminJobOperationRoot,
  readProjection,
  reserveCoordinatorPullSubmission,
  resumeAdminJobObservation,
} from "./admin-job-ops";
import { issueApiJobChildAssertion, prepareApiJobChildAttempt } from "./admin-job-parent";
import {
  type AdminJobProtocol,
  cancelRequestedAt,
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
  ConfigurationWriteCommitUnknown,
  ConfigurationWriteRolledBack,
  type ConfigurationWriteTransaction,
  currentAdministrativeConfigurationWriter,
  withAdministrativeConfigurationRead,
  withConfigurationWriteTransaction,
} from "./administrative-configuration-writer";
import {
  discardConfigurationCandidate,
  findConfigurationCandidate,
  readConfigurationCandidate,
  retainConfigurationCandidate,
} from "./configuration-candidate-store";
import {
  completedCoordinatorMaintenance,
  completedCoordinatorMaintenanceSchema,
  maintenanceSettleCheckpointSchema,
  settledRecordOf,
} from "./configuration-maintenance-checkpoint";
import type { MigrationResult } from "./configuration-migration/apply";
import { migrationCompletionResult } from "./configuration-migration/completion";
import {
  assertStagedMigrationOverlay,
  isStagedMigrationParticipant,
  retainedStagedMigration,
  retainedStagedMigrationSource,
  stagedMigrationHasPlatform,
  stagedMigrationPatch,
} from "./configuration-migration/participant";
import {
  ConfigurationSourceOwned,
  IntegrationConfigurationConflict,
  integrationOwnershipSnapshot,
  projectFieldOwnership,
} from "./configuration-ownership-view";
import {
  assertConfigurationSavedRows,
  type ConfigurationSavedRow,
  configurationSavedRowSchema,
} from "./configuration-saved-rows";
import {
  assertCoordinatorLifecycleIntent,
  assertRetainedCoordinatorLifecycleProvenance,
  type CoordinatorLifecycleIntent,
  closeUnissuedCoordinatorPull,
  coordinatorLifecycleOperationKey,
} from "./coordinator-lifecycle";
import { readExtensionWorkflow } from "./extension-workflow";
import {
  assertIntegrationBindingOverlay,
  assertSavedIntegrationBinding,
} from "./integration-binding-participant";
import { capturedBindingState } from "./integration-binding-state";
import { integrationConfigRevision } from "./integration-runtime-evidence";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import {
  guardedSystemReleasePayloadSchema,
  platformJobMatchesPreview,
} from "./platform-configuration-job";
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
  readonly payloadBytes: number;
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
  sealed: Omit<ReturnType<typeof prepareConfigurationCandidate>, "operation"> & {
    operation: OpsOperation;
  };
  record: PreparedConfigurationRecord;
  publisher: { token: string };
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
  stage?: CandidateStage;
  /** Restored after a restart: its rows were saved, or no maintenance root was attempted. */
  recovered?: "committed" | "pre_root";
  /** A known local refusal before any maintenance admission was attempted. */
  rejectedUnissued?: boolean;
  discardedUnused?: MaintenanceRecord;
}
type CandidateStage =
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
  | "retired";
const REJECTED = "Trusted configuration snapshot publish failed";
/** A preparation this close to its deadline is not saved under: its apply could
 * not be admitted any more, and the rows would wait for a maintenance that ends. */
const MAINTENANCE_APPLY_MARGIN_MS = 60_000;
const candidates = new WeakMap<ValidatedConfigurationCandidate, CandidateState>();
function stageOf(candidate: ValidatedConfigurationCandidate): CandidateStage | undefined {
  return candidates.get(candidate)?.stage;
}
function setStage(candidate: ValidatedConfigurationCandidate, stage: CandidateStage): void {
  const state = candidates.get(candidate);
  if (!state) throw Error("Configuration candidate unavailable");
  state.stage = stage;
}
const recoveredAs = (candidate: ValidatedConfigurationCandidate) =>
  candidates.get(candidate)?.recovered;
/** A known comparison/refusal produced here selects an inert intent failure.
 * External exceptions and observer aborts never mint this local evidence. */
function rejectUnissuedCandidate(
  candidate: ValidatedConfigurationCandidate,
  message: string,
): never {
  const state = candidates.get(candidate);
  if (state) state.rejectedUnissued = true;
  throw Error(message);
}
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
  if (state.overlay.purpose === "migration") {
    if (
      recoveredAs(candidate) === "committed" &&
      state.record.privateIntegrationReload?.stagedMigration
    ) {
      await (await import("./configuration-migration/staging")).assertRetainedMigrationRows(
        {
          previewId: state.record.privateIntegrationReload.stagedMigration.previewId,
          actorId: writer.actorId,
          jobId: owner.job.jobId,
          candidateId: candidate.candidateId,
        },
        owner.connection,
      );
    } else if (owner.participant && isStagedMigrationParticipant(owner.participant, writer))
      assertStagedMigrationOverlay(writer, state.overlay);
    else throw Error("Configuration commit participant unavailable");
  }
  if (state.overlay.purpose === "integration-binding")
    assertIntegrationBindingOverlay(writer, state.overlay);
  if (state.overlay.purpose === "platform") {
    if (recoveredAs(candidate) === "committed") {
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
          protocol: owner.job.protocol,
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
      canonicalJson({ ...state.record.privatePlatformIntent, authorization: undefined }) !==
        canonicalJson({ ...intent, authorization: undefined })
    )
      throw Error("Original platform candidate required");
  }
  await owner.participant?.verify(candidate, writer);
}
export function assertCommittedConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): void {
  validatedConfigurationCandidateState(candidate);
  if (stageOf(candidate) !== "committed") throw Error("Committed configuration candidate required");
}
function _assertKnownRolledBackConfigurationCandidate(
  candidate: ValidatedConfigurationCandidate,
): void {
  const state = validatedConfigurationCandidateState(candidate);
  if (state.persisted || stageOf(candidate) !== "rolled_back")
    throw Error("Actual original rolled-back candidate required");
}
function assertUnadmittedConfigurationCandidate(candidate: ValidatedConfigurationCandidate): void {
  const state = validatedConfigurationCandidateState(candidate);
  const stage = stageOf(candidate);
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
    !["prepared", "recovered_unissued"].includes(stageOf(candidate) ?? "") ||
    state.persisted
  )
    throw new JobObservationPending("recovery_required");
  const fixed = record.coordinatorPrerequisite,
    projection = readProjection(owner.job.protocol, owner.job.checkpointResult);
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
    const entry = readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
      originalPull.operationKey
    ];
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
          protocol: schema.adminJob.protocol,
          payload: schema.adminJob.payload,
          type: schema.adminJob.type,
        })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      actual = readProjection(protocol, result),
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
              protocol,
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
      hasUnsettledManagedOperation(result, protocol) ||
      (helper &&
        (canonicalJson(helper.operation) !== canonicalJson(fixed!.operation) ||
          !helper.receiptDelivery ||
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
  setStage(candidate, "unissued");
  await discardUnadmittedTrustedConfigurationCandidate(candidate);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(checkpoint._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
  });
  setStage(candidate, "discarded");
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
    stageOf(candidate) !== "discarded" ||
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
          protocol: schema.adminJob.protocol,
          payload: schema.adminJob.payload,
          type: schema.adminJob.type,
        })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      projection = readProjection(protocol, result),
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
              protocol,
              lifecycle.originalOrdinal,
            )
          : { operationKeys: new Set<string>(), revisionId: candidate.expectedCurrentRevisionId };
    if (prefix.revisionId !== candidate.expectedCurrentRevisionId)
      throw new JobObservationPending("invalid_identity");
    if (
      !result ||
      !cancelRequestedAt(protocol) ||
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
      hasUnsettledManagedOperation(result, protocol) ||
      (helper &&
        (!helper.receiptDelivery ||
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
 * never-prepared closure and delivers the original canonical failure. Inspection is
 * performed here; a portable receipt/boolean supplied by a caller is useless. */
export async function discardNeverPreparedProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    stage = stageOf(candidate);
  if (
    !state.record.maintenanceId ||
    !state.record.prepareOperationKey ||
    !["prepared", "recovered_pre_save", "never_prepared"].includes(stage ?? "")
  )
    throw Error("Original inert maintenance candidate required");
  const { inspectConfigurationMaintenance } = await configurationMaintenanceProtocol,
    closed = await inspectConfigurationMaintenance(state.record.maintenanceId);
  if (
    closed.state !== "settled" ||
    closed.fence !== null ||
    closed.generation !== "not_started" ||
    closed.appliedRevisionId !== null ||
    closed.followUp !== "not_started"
  )
    throw Error("Conclusive never-prepared maintenance closure required");
  let checkpoint: Record<string, unknown> | undefined;
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx) => {
      // The same owned row lock waits out any earlier save/checkpoint transaction.
      const [row] = await tx
        .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update");
      const result = row?.result as Record<string, unknown> | undefined,
        protocol = row?.protocol as AdminJobProtocol | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined,
        projected = readProjection(protocol, result).operations[state.record.prepareOperationKey!];
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
        !projected?.terminal ||
        !projected.receiptDelivery ||
        projected.kind !== "configurationMaintenance.prepare" ||
        projected.operationId !== closed.prepare.executionId ||
        projected.fingerprint !== closed.prepare.fingerprint ||
        hasUnsettledManagedOperation(result, protocol)
      )
        throw Error("Original unsaved candidate closure checkpoint required");
      checkpoint = {
        ...result,
        _configurationCandidate: {
          ...retained,
          phase: "discarding_without_guard",
        },
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
  setStage(candidate, "never_prepared");
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
  setStage(candidate, "discarded");
}
/** A failed prepare is not itself never-prepared evidence. Only the actual fixed
 * inspector/disjoint closure and original canonical failure above permit this
 * inert cleanup and truthful failed configuration result. */
async function completeNeverPreparedConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<TrustedConfigurationApplyOutcome> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    projected =
      state.record.prepareOperationKey &&
      readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
        state.record.prepareOperationKey
      ],
    terminal =
      projected && projected.receiptDelivery !== undefined
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
  const closed = await inspectConfigurationMaintenance(state.record.maintenanceId!);
  if (
    closed.state !== "settled" ||
    closed.fence !== null ||
    closed.binding.candidateId !== candidate.candidateId ||
    closed.prepare.operationKey !== state.record.prepareOperationKey
  )
    throw new JobObservationPending("recovery_required");
  const configuration: TrustedConfigurationApplyOutcome = {
    outcome: "not_committed",
    reason: terminal.errorClass === "busy" ? "busy" : "failed",
    cleanupFailed: false,
    registryUpdateFailed: false,
  };
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationMaintenance: {
      ...(owner.job.checkpointResult?._configurationMaintenance as Record<string, unknown>),
      phase: "settled",
      record: closed,
    },
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
      stageOf(candidate) ?? "",
    )
  )
    throw Error("Original unsaved prepared candidate required");
  const maintenance = await configurationMaintenanceProtocol,
    closed = await maintenance.inspectConfigurationMaintenance(state.record.maintenanceId);
  if (
    closed.state !== "settled" ||
    closed.fence?.state !== "settled" ||
    closed.fenceOutcome !== "unused" ||
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
        .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
      settle = maintenanceSettleCheckpointSchema.parse(result?._configurationMaintenanceSettle),
      projection = readProjection(protocol, result),
      canonical = settledRecordOf(projection.operations[settle.operationKey]);
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
      settle.outcome !== "abandon" ||
      !canonical ||
      canonicalJson(canonical) !== canonicalJson(remote.record) ||
      canonicalJson(closed) !== canonicalJson(canonical) ||
      hasUnsettledManagedOperation(result, protocol)
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
  setStage(candidate, "unused");
  await discardUnadmittedTrustedConfigurationCandidate(candidate);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: {
      ...(committed._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
  });
  setStage(candidate, "discarded");
  freeze(closed);
  state.discardedUnused = closed;
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
    closed = state.discardedUnused;
  if (
    !closed ||
    stageOf(candidate) !== "discarded" ||
    state.persisted ||
    !record.maintenanceId ||
    !record.prepareOperationKey
  )
    throw new JobObservationPending("recovery_required");
  let committed: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(state.writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined,
      remote = result?._configurationMaintenance as Record<string, unknown> | undefined,
      settle = maintenanceSettleCheckpointSchema.parse(result?._configurationMaintenanceSettle),
      projection = readProjection(protocol, result),
      canonical = settledRecordOf(projection.operations[settle.operationKey]);
    if (
      !result ||
      !cancelRequestedAt(protocol) ||
      retained?.candidateId !== candidate.candidateId ||
      retained.operationKey !== candidate.operationKey ||
      retained.revisionId !== candidate.revisionId ||
      retained.sealedOperationKey !== record.operationKey ||
      retained.maintenanceId !== record.maintenanceId ||
      retained.prepareOperationKey !== record.prepareOperationKey ||
      retained.phase !== "discarded" ||
      retained.rowVersions !== undefined ||
      remote?.phase !== "settled" ||
      settle.outcome !== "abandon" ||
      !canonical ||
      canonicalJson(canonical) !== canonicalJson(remote.record) ||
      canonicalJson(closed) !== canonicalJson(canonical) ||
      hasUnsettledManagedOperation(result, protocol)
    )
      throw new JobObservationPending("recovery_required");
    const configuration: TrustedConfigurationApplyOutcome = {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
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
      actual = await maintenance.inspectConfigurationMaintenance(state.record.maintenanceId);
    contained =
      actual.generation === "not_committed" &&
      actual.appliedRevisionId === null &&
      actual.followUp === "contained";
    if (
      actual.state !== "settled" ||
      actual.fence?.state !== "settled" ||
      (!contained &&
        (actual.generation !== "committed" ||
          actual.appliedRevisionId !== candidate.revisionId ||
          actual.followUp !== "complete")) ||
      actual.prepare.operationKey !== state.record.prepareOperationKey
    )
      throw Error("Actual original maintenance closure required before cleanup");
  }
  const [job] = await owner.connection
    .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
    .from(schema.adminJob)
    .where(jobOwnership(owner.job.jobId, owner.job.execution));
  const result = job?.result as Record<string, unknown> | undefined;
  const protocol = job?.protocol as AdminJobProtocol | undefined;
  const receipt = result?._configurationCandidate as Record<string, unknown> | undefined;
  if (
    !result ||
    receipt?.candidateId !== candidate.candidateId ||
    receipt.revisionId !== candidate.revisionId ||
    receipt.operationKey !== candidate.operationKey ||
    receipt.sealedOperationKey !== state.record.operationKey ||
    (receipt.phase !== "settled" &&
      !(
        state.record.privateIntegrationReload?.stagedMigration &&
        ["saved", "follow_up_pending"].includes(String(receipt.phase)) &&
        canonicalJson(result.migration) ===
          canonicalJson(
            migrationCompletionResult({
              operationId: owner.job.jobId,
              steps: (result._migrationSteps ?? []) as MigrationResult["steps"],
              pendingServiceIds: z
                .array(id)
                .max(256)
                .optional()
                .parse(result._migrationPendingServiceIds),
              application: parseTrustedConfigurationApplyOutcome(result.configuration),
            }),
          ) &&
        (result.migration as MigrationResult | undefined)?.outcome !== "unknown"
      )) ||
    hasUnsettledManagedOperation(result, protocol)
  )
    throw Error("Configuration candidate settlement unavailable");
  const outcomes = result._configurationOutcomes as Record<string, unknown> | undefined;
  const outcome = parseTrustedConfigurationApplyOutcome(outcomes?.[candidate.operationKey]);
  if (
    contained
      ? outcome.outcome !== "not_committed" || outcome.cleanupFailed || outcome.registryUpdateFailed
      : !completeTrustedConfigurationApply(outcome) ||
        outcome.outcome !== "committed" ||
        outcome.revisionId !== candidate.revisionId
  )
    throw Error("Configuration candidate application unavailable");
  if (state.record.maintenanceId) {
    const remote = result._configurationMaintenance as Record<string, unknown> | undefined,
      settled = maintenanceRecordSchema.parse(remote?.record),
      projection = readProjection(protocol, result),
      delivered = settledRecordOf(
        projection.operations[
          maintenanceSettleCheckpointSchema.parse(result._configurationMaintenanceSettle)
            .operationKey
        ],
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
      canonicalJson(delivered) !== canonicalJson(settled)
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
          .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
          .from(schema.adminJob)
          .where(jobOwnership(job.jobId, job.execution))
          .for("update"),
        proof = (current?.result as Record<string, unknown> | undefined)?._configurationCandidate as
          | Record<string, unknown>
          | undefined;
      if (
        proof?.candidateId !== candidate.candidateId ||
        proof.revisionId !== candidate.revisionId ||
        (proof.phase !== "settled" &&
          !(state.record.privateIntegrationReload?.stagedMigration && proof.phase === "saved"))
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
        "integration.binding.apply",
        "configuration.migration.apply",
        "credential.import",
      ].includes(job.jobType ?? ""))
  ) {
    const original = job.checkpointResult;
    if (!original) throw new JobObservationPending("recovery_required");
    const result = {
        configuration: original.configuration,
        ...(original.migration ? { migration: original.migration } : {}),
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
      },
      operationKey = state.record.maintenanceId
        ? maintenanceSettleCheckpointSchema.parse(original._configurationMaintenanceSettle)
            .operationKey
        : state.record.apiFollowUp === "service-apply" && "serviceId" in state.sealed.operation
          ? createDurableOpsKey(
              "admin-job.credential.recreate",
              `${job.jobId}:${state.sealed.operation.serviceId}`,
            )
          : state.record.operationKey;
    let completedCoordinator: Record<string, unknown> = {};
    if (queuedCoordinator && state.record.privateCoordinatorLifecycle?.action === "update") {
      const settled = maintenanceSettleCheckpointSchema.parse(
        original._configurationMaintenanceSettle,
      );
      const source = original._configurationCandidate as Record<string, unknown>;
      const archived = completedCoordinatorMaintenanceSchema.parse({
        version: 2,
        originalOrdinal: state.record.privateCoordinatorLifecycle.originalOrdinal,
        candidate: {
          candidateId: source.candidateId,
          maintenanceId: source.maintenanceId,
          prepareOperationKey: source.prepareOperationKey,
          revisionId: source.revisionId,
          operationKey: source.operationKey,
          phase: source.phase,
        },
        record: (original._configurationMaintenance as { record: unknown }).record,
        settlementOperationKey: settled.operationKey,
      });
      completedCoordinator = { _completedCoordinatorMaintenance: archived };
      completedCoordinatorMaintenance({ ...original, ...completedCoordinator }, job.protocol);
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
        phase: "settled",
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
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationCandidate: {
        ...(job.checkpointResult?._configurationCandidate as Record<string, unknown>),
        phase: "unknown",
      },
    });
    throw new JobObservationPending("recovery_required");
  }
  setStage(candidate, "retired");
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
function retainedConfigurationRetirementState(handle: RetainedConfigurationRetirement) {
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

/** Only original negative recovery and a fresh authenticated never-prepared inspection
 * authorize finishing an interrupted inert unlink. The marker selects this
 * verifier; it neither proves absence nor grants a new configuration effect. */
async function resumeCompletedConfigurationRetirement(): Promise<Record<string, unknown>> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer);
  let original: Record<string, unknown> | undefined;
  let originalProtocol: AdminJobProtocol | undefined;
  await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(job.jobId, job.execution))
      .for("update");
    original = row?.result as Record<string, unknown> | undefined;
    originalProtocol = row?.protocol as AdminJobProtocol | undefined;
    const retained = original?._configurationCandidate as Record<string, unknown> | undefined,
      retirement = retirementSchema.parse(retained?.retirement);
    const queued =
      row?.type === job.jobType &&
      canonicalJson(row?.payload) === canonicalJson(job.payload) &&
      writer.actorId === job.jobId &&
      ((row.type === "service.apply" &&
        job.payload.service === "data-manager" &&
        Object.keys(job.payload).every(
          (key) => key === "service" || key === "_maintenanceRequest",
        ) &&
        writer.operationKey === coordinatorLifecycleOperationKey(job.jobId, null)) ||
        (row.type === "service.bulk" &&
          job.payload.action === "update" &&
          completedCoordinatorMaintenance(original!, originalProtocol).record.apiJobId ===
            job.jobId &&
          writer.operationKey ===
            coordinatorLifecycleOperationKey(
              job.jobId,
              completedCoordinatorMaintenance(original!, originalProtocol).originalOrdinal,
            )));
    const queuedRelease =
      row?.type === "system.update" &&
      job.jobType === row.type &&
      row.createdBy === writer.actorId &&
      canonicalJson(row.payload) === canonicalJson(job.payload) &&
      guardedSystemReleasePayloadSchema.safeParse(row.payload).success &&
      writer.operationKey === createDurableOpsKey("admin-job.guarded-release", job.jobId) &&
      (original?._systemRelease as { actorId?: unknown; operationKey?: unknown } | undefined)
        ?.actorId === writer.actorId &&
      (original?._systemRelease as { operationKey?: unknown } | undefined)?.operationKey ===
        writer.operationKey;
    if (
      !original ||
      (!queued &&
        !queuedRelease &&
        (original._immediateJobId !== job.jobId ||
          original._immediateActorId !== writer.actorId)) ||
      retained?.operationKey !== writer.operationKey ||
      retained.phase !== "settled" ||
      canonicalJson(retirement.integrationIds) !== canonicalJson(writer.integrationIds) ||
      hasUnsettledManagedOperation(original, originalProtocol)
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
    const actual = await (await configurationMaintenanceProtocol).inspectConfigurationMaintenance(
        String(retained.maintenanceId),
      ),
      remote = original._configurationMaintenance as
        | { record?: unknown; phase?: string }
        | undefined;
    if (
      actual.state !== "settled" ||
      actual.fence?.state !== "settled" ||
      remote?.phase !== "settled" ||
      canonicalJson(actual) !== canonicalJson(remote.record)
    )
      throw new JobObservationPending("recovery_required");
  }
  const handle = Object.freeze({}) as RetainedConfigurationRetirement;
  retirements.set(handle, {
    writer,
    publisher: publisherOptions(await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""))),
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
async function withProspectiveConfigurationRead<T>(
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
  const state = validatedConfigurationCandidateState(candidate);
  assertCommittedConfigurationCandidate(candidate);
  if (
    state.record.privateIntegrationReload?.stagedMigration &&
    state.record.privateIntegrationReload.integrations.length === 0
  ) {
    await withAdministrativeConfigurationRead({}, async (read) => {
      if (read.integrations.length) throw Error("Integration source changed");
    });
    return { message: "No integration providers", reloaded: 0, enabled: 0 };
  }
  await assertCurrentIntegrationReloadSources(candidate);
  const { reloadIntegrations } = await import("../integration-host");
  if (recoveredAs(candidate) !== "committed")
    return withProspectiveConfigurationRead(candidate, (read) => reloadIntegrations(read));
  const retained = state.record.privateIntegrationReload;
  if (
    (state.record.apiFollowUp !== "integration-reload" && !retained?.stagedMigration) ||
    !retained ||
    !retained.bindings
  )
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
    const staged = record.privateIntegrationReload?.stagedMigration;
    if (
      !staged ||
      !["integration-reload", "platform-apply"].includes(record.apiFollowUp ?? "") ||
      canonicalJson(staged.integrationIds) !==
        canonicalJson([...new Set(staged.integrationIds)].sort()) ||
      overlay.changes.some(
        (c) => "integrationId" in c && !staged.integrationIds.includes(c.integrationId),
      )
    )
      throw new JobObservationPending("recovery_required");
    return staged.integrationIds;
  }
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
    if (
      retained?.maintenanceId === null &&
      ["discarding_unissued", "discarded"].includes(String(retained.phase)) &&
      retained.operationKey === operationKey
    )
      return retirementSchema.parse(retained.unissuedCleanup).integrationIds;
    if (retained?.retirement !== undefined)
      return retirementSchema.parse(retained.retirement).integrationIds;
    if (typeof retained?.sealedOperationKey !== "string") throw Error();
    const { record } = await readConfigurationCandidate(retained.sealedOperationKey);
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
async function sourceFingerprint(context: AdministrativeConfigurationReadContext): Promise<string> {
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
  return apiKeyedDigest("configuration-source", {
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
  });
}
function publisherOptions(token: string) {
  return { token };
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
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", "")),
    publisher = publisherOptions(token);
  let checkpoint: Record<string, unknown> | undefined;
  const candidate = await withConfigurationWriteTransaction(writer, async (tx, read) => {
    const [row] = await tx
        .select()
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
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
      rolledBack = retained.phase === "rolled_back";
    if (!saved && retained.rowVersions !== undefined)
      throw new JobObservationPending("recovery_required");
    const inspected = await readConfigurationCandidate(retained.sealedOperationKey),
      record = inspected.record,
      coordinator =
        record.privateCoordinatorLifecycle && row
          ? assertRetainedCoordinatorLifecycleProvenance(row, record)
          : undefined,
      platform = record.privatePlatformIntent,
      operation = opsOperationSchema.parse(record.operation),
      overlay = overlaySchema.parse(record.privateOverlay),
      projection = readProjection(protocol, result),
      preparation = record.prepareOperationKey
        ? projection.operations[record.prepareOperationKey]
        : undefined,
      preRoot =
        !saved &&
        !preparation &&
        result._configurationMaintenance === undefined &&
        (record.privateMaintenancePreparation !== undefined ||
          record.privateCoordinatorSource !== undefined ||
          !!record.privateIntegrationReload?.stagedMigration);
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
          : record.privateIntegrationReload?.stagedMigration
            ? overlay.purpose !== "migration" ||
              !["integration-reload", "platform-apply"].includes(record.apiFollowUp ?? "") ||
              !["configuration.migration.apply", "credential.import"].includes(job.jobType ?? "") ||
              canonicalJson(writer.integrationIds) !==
                canonicalJson(retainedIntegrationIds(record, overlay))
            : !platform ||
              !row ||
              !platformJobMatchesPreview(row, { release: platform.release }) ||
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
      // Unsaved rows never had an apply.
      (!saved &&
        Object.values(projection.operations).some(
          (value) => value.operation?.kind === "configurationMaintenance.apply",
        ))
    )
      throw new JobObservationPending("recovery_required");
    if (rolledBack) {
      // A known rollback after the maintenance prepared: nothing was saved and
      // the prepared maintenance is abandoned next.
      const remote = result._configurationMaintenance as Record<string, unknown> | undefined,
        delivery = preparation?.receiptDelivery;
      if (
        !remote ||
        !["prepared", "settled"].includes(String(remote.phase)) ||
        remote.prepareOperationKey !== record.prepareOperationKey ||
        !delivery ||
        delivery.terminalReceipt.state !== "succeeded" ||
        result._dataExecutions !== undefined
      )
        throw new JobObservationPending("recovery_required");
    }
    if (saved) {
      const rowVersions = z.array(configurationSavedRowSchema).max(512).parse(retained.rowVersions),
        remote = result._configurationMaintenance as Record<string, unknown> | undefined;
      if (
        remote?.prepareOperationKey !== record.prepareOperationKey ||
        !preparation?.receiptDelivery ||
        preparation.receiptDelivery.terminalReceipt.state !== "succeeded"
      )
        throw new JobObservationPending("recovery_required");
      await assertConfigurationSavedRows(tx, rowVersions);
      if (record.privateIntegrationReload?.stagedMigration)
        await (await import("./configuration-migration/staging")).assertRetainedMigrationRows(
          {
            previewId: record.privateIntegrationReload.stagedMigration.previewId,
            actorId: writer.actorId,
            jobId: job.jobId,
            candidateId: record.candidateId,
          },
          tx,
        );
      if (
        coordinator &&
        (rowVersions.some((row) => row.rowVersion !== row.previousRowVersion) ||
          (await sourceFingerprint(read)) !== record.sourceFingerprint)
      )
        throw new JobObservationPending("recovery_required");
    }
    // inspectPrepared... already authenticated these EXACT historical bytes.
    // Parsing their payload is not opening an expired apply claim or resealing.
    const payload = inspected.payload,
      candidate = Object.freeze({
        candidateId: record.candidateId,
        operationKey: writer.operationKey,
        expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
        revisionId: inspected.snapshot.revisionId,
        sourceFingerprint: record.sourceFingerprint,
        payloadBytes: Buffer.byteLength(JSON.stringify(inspected.payload)),
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
          protocol,
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
        snapshot: inspected.snapshot,
      },
    };
    if (preRoot && record.privateIntegrationReload?.stagedMigration) {
      if (Object.keys(projection.operations).length || result._dataExecutions !== undefined)
        throw new JobObservationPending("recovery_required");
      candidates.set(candidate, state);
      setStage(candidate, "recovered_unissued");
      checkpoint = result;
      return candidate;
    }
    if (preRoot && coordinator) {
      const prefix =
        coordinator.action === "update"
          ? await (await import("./service-update-batch")).completedServiceUpdatePrefix(
              job.jobId,
              row!.payload,
              result,
              protocol,
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
        protocol?.cancelRequestedAt !== undefined ||
        Date.now() >= record.parentDeadlineAt ||
        Date.now() >= parseControlRootOperationKey(record.prepareOperationKey!).notAfter ||
        inspected.snapshot.expiresAt <= new Date().toISOString() ||
        (await sourceFingerprint(read)) !== record.sourceFingerprint
      ) {
        candidates.set(candidate, state);
        setStage(candidate, "recovered_unissued");
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
      state.recovered = "pre_root";
    } else if (preRoot && overlay.purpose === "transit-credentials") {
      if (Object.keys(projection.operations).length || result._dataExecutions !== undefined)
        throw new JobObservationPending("recovery_required");
      candidates.set(candidate, state);
      setStage(candidate, "recovered_unissued");
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
        protocol?.cancelRequestedAt !== undefined ||
        Date.now() >= record.parentDeadlineAt ||
        Date.now() >= parseControlRootOperationKey(record.prepareOperationKey!).notAfter ||
        inspected.snapshot.expiresAt <= new Date().toISOString() ||
        (await sourceFingerprint(read)) !== record.sourceFingerprint
      ) {
        // The original private bytes/locked prepared checkpoint prove which
        // helper to OBSERVE, or its explicit nonissuance before this new claim.
        // The cleanup rechecks that original locked no-attempt state. This
        // recovery-only stage has no prepared rows/source and cannot persist,
        // render, reseal or prepare a maintenance root.
        candidates.set(candidate, state);
        setStage(candidate, "recovered_unissued");
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
      state.recovered = "pre_root";
    }
    candidates.set(candidate, state);
    setStage(
      candidate,
      saved
        ? "committed"
        : rolledBack
          ? "rolled_back"
          : preRoot
            ? "prepared"
            : "recovered_pre_save",
    );
    if (saved) state.recovered = "committed";
    checkpoint = result;
    return candidate;
  });
  if (!checkpoint) throw new JobObservationPending("recovery_required");
  job.checkpointResult = checkpoint;
  return candidate;
}
/** Only the exact prepared ordinary packet can start this cleanup. The owned
 * row records its authenticated disposition before unlink; recovery of that
 * same disposition may finish a missing prior unlink, never an apply/save. */
async function discardRetainedUnissuedOrdinaryCandidate(): Promise<Record<string, unknown>> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer),
    publisher = publisherOptions(await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", "")));
  let checkpoint: Record<string, unknown> | undefined,
    cancelRequested = false;
  await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
        .select()
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
      retained = result?._configurationCandidate as Record<string, unknown> | undefined;
    if (
      !row ||
      !result ||
      row.type !== job.jobType ||
      canonicalJson(row.payload ?? {}) !== canonicalJson(job.payload) ||
      !job.execution ||
      job.execution.version < 2 ||
      (writer.actorId !== job.jobId && result._immediateActorId !== writer.actorId) ||
      retained?.operationKey !== writer.operationKey ||
      retained.maintenanceId !== null ||
      retained.prepareOperationKey !== null ||
      retained.rowVersions !== undefined ||
      !["prepared", "discarding_unissued", "discarded"].includes(String(retained.phase)) ||
      result._configurationMaintenance !== undefined ||
      result._configurationMaintenanceDecision !== undefined ||
      result._configurationMaintenanceRollback !== undefined ||
      Object.keys(readProjection(protocol, result).operations).length !== 0 ||
      hasUnsettledManagedOperation(result, protocol)
    )
      throw new JobObservationPending("recovery_required");
    if (retained.phase === "prepared") {
      const { record, snapshot } = await readConfigurationCandidate(
          String(retained.sealedOperationKey),
        ),
        operation = opsOperationSchema.parse(record.operation);
      if (
        record.apiJobId !== job.jobId ||
        record.actorId !== writer.actorId ||
        record.candidateId !== retained.candidateId ||
        record.operationKey !== retained.sealedOperationKey ||
        record.sourceFingerprint !== retained.sourceFingerprint ||
        snapshot.revisionId !== retained.revisionId ||
        snapshot.operationFingerprint !== opsOperationFingerprint(operation) ||
        record.maintenanceId !== null ||
        record.prepareOperationKey !== null ||
        canonicalJson(
          retainedIntegrationIds(record, overlaySchema.parse(record.privateOverlay)),
        ) !== canonicalJson(writer.integrationIds)
      )
        throw new JobObservationPending("recovery_required");
    } else if (
      canonicalJson(retirementSchema.parse(retained.unissuedCleanup).integrationIds) !==
      canonicalJson(writer.integrationIds)
    )
      throw new JobObservationPending("recovery_required");
    cancelRequested = protocol?.cancelRequestedAt !== undefined;
    checkpoint = {
      ...result,
      _configurationCandidate: {
        ...retained,
        phase: "discarding_unissued",
        unissuedCleanup: { version: 1, integrationIds: [...writer.integrationIds] },
      },
    };
    const saved = await tx
      .update(schema.adminJob)
      .set({ result: checkpoint })
      .where(jobOwnership(job.jobId, job.execution))
      .returning({ id: schema.adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (!checkpoint) throw new JobObservationPending("recovery_required");
  job.checkpointResult = checkpoint;
  const handle = Object.freeze({}) as RetainedConfigurationRetirement;
  retirements.set(handle, {
    writer,
    publisher,
    checkpoint: checkpoint._configurationCandidate as Record<string, unknown>,
    apiJobId: job.jobId,
    actorId: writer.actorId,
  });
  try {
    await completeRetainedConfigurationRetirement(handle);
  } finally {
    retirements.delete(handle);
  }
  const configuration: TrustedConfigurationApplyOutcome = {
    outcome: "not_committed",
    reason: "conflict",
    cleanupFailed: false,
    registryUpdateFailed: false,
  };
  await job.checkpoint({
    ...job.checkpointResult,
    _configurationCandidate: {
      ...(checkpoint._configurationCandidate as Record<string, unknown>),
      phase: "discarded",
    },
    configuration,
    _configurationOutcomes: {
      ...(checkpoint._configurationOutcomes as Record<string, unknown>),
      [writer.operationKey]: configuration,
    },
  });
  if (cancelRequested) {
    await withConfigurationWriteTransaction(writer, async (tx) => {
      const saved = await tx
        .update(schema.adminJob)
        .set({ status: "canceled", finishedAt: new Date(), result: job.checkpointResult })
        .where(jobOwnership(job.jobId, job.execution))
        .returning({ id: schema.adminJob.id });
      if (saved.length !== 1) throw new JobObservationPending("recovery_required");
    });
  }
  return { configuration };
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
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", "")),
    publisher = publisherOptions(token);
  let checkpoint: Record<string, unknown> | undefined;
  const candidate = await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
        .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
        .from(schema.adminJob)
        .where(jobOwnership(job.jobId, job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      protocol = row?.protocol as AdminJobProtocol | undefined,
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
    const inspected = await readConfigurationCandidate(retained.sealedOperationKey),
      record = inspected.record,
      operation = opsOperationSchema.parse(record.operation),
      overlay = overlaySchema.parse(record.privateOverlay),
      parent = {
        operationKey: record.parentOperationKey,
        fingerprint: record.parentFingerprint,
        deadlineAt: record.parentDeadlineAt,
      },
      projection = readProjection(protocol, result),
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
          !!record.privateIntegrationReload?.stagedMigration);
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
      (overlay.purpose === "migration") !==
        ["configuration.migration.apply", "credential.import"].includes(job.jobType ?? "") ||
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
    if (record.privateIntegrationReload?.stagedMigration)
      await (await import("./configuration-migration/staging")).assertRetainedMigrationRows(
        {
          previewId: record.privateIntegrationReload.stagedMigration.previewId,
          actorId: writer.actorId,
          jobId: job.jobId,
          candidateId: record.candidateId,
        },
        tx,
      );
    const payload = inspected.payload,
      candidate = Object.freeze({
        candidateId: record.candidateId,
        operationKey: writer.operationKey,
        expectedCurrentRevisionId: operation.expectedCurrentRevisionId,
        revisionId: inspected.snapshot.revisionId,
        sourceFingerprint: record.sourceFingerprint,
        payloadBytes: Buffer.byteLength(JSON.stringify(inspected.payload)),
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
        snapshot: inspected.snapshot,
      },
    });
    setStage(candidate, "committed");
    validatedConfigurationCandidateState(candidate).recovered = "committed";
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
    originalProtocol: AdminJobProtocol | undefined,
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
    originalProtocol = row.protocol as AdminJobProtocol;
    if (original._configurationCandidate !== undefined)
      throw new JobObservationPending("recovery_required");
    const { parseServiceUpdateBatch, completedServiceUpdatePrefix } = await import(
        "./service-update-batch"
      ),
      batch = parseServiceUpdateBatch(row.payload, original),
      ordinal = batch.serviceIds.indexOf("data-manager"),
      projection = readProjection(originalProtocol, original),
      address = createDurableOpsKey("configuration.coordinator-pull", `${job.jobId}:${ordinal}`);
    entry = projection.operations[projection.steps[address]?.operationKey ?? address];
    if (!entry) return;
    const prefix = await completedServiceUpdatePrefix(
      job.jobId,
      row.payload,
      original,
      originalProtocol,
      ordinal,
    );
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
  const publisher = publisherOptions(await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""))),
    retained = await findConfigurationCandidate(operation.candidateId);
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
      payloadBytes: Buffer.byteLength(JSON.stringify(retained.payload)),
      affectedServiceIds: Object.freeze([...record.affectedServiceIds]),
    }) as ValidatedConfigurationCandidate;
    candidates.set(candidate, {
      writer,
      record,
      overlay: overlaySchema.parse(record.privateOverlay),
      payload: retained.payload,
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
        snapshot: retained.snapshot,
      },
    });
    setStage(candidate, "unissued");
    await discardUnadmittedTrustedConfigurationCandidate(candidate);
    setStage(candidate, "discarded");
  }
  throw new AdminJobFailure("Original configuration candidate was not issued", {
    configuration: {
      outcome: "not_committed",
      reason: "conflict",
      cleanupFailed: false,
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
  if (
    current?.maintenanceId === null &&
    ["prepared", "discarding_unissued", "discarded"].includes(String(current.phase))
  )
    return discardRetainedUnissuedOrdinaryCandidate();
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
  if (stageOf(candidate) === "recovered_unissued") {
    await discardUnissuedMaintenanceCandidate(candidate);
    if (job.protocol?.cancelRequestedAt !== undefined)
      return completeUnissuedConfigurationCancellation(candidate);
    const configuration: TrustedConfigurationApplyOutcome = {
      outcome: "not_committed",
      reason: "conflict",
      cleanupFailed: false,
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
  if (recoveredAs(candidate) === "pre_root") {
    const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
      coordinatorMode: state.overlay.coordinatorMode,
      signal: job.signal,
    });
    return { configuration: receipt.application };
  }
  if (recoveredAs(candidate) === "committed") {
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
      (state.record.apiFollowUp !== "integration-reload" &&
        !state.record.privateIntegrationReload?.stagedMigration) ||
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
        integrationReload: {
          state: "complete",
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
          result: reloaded,
        },
      });
    }
    let migration: MigrationResult | undefined;
    if (state.record.privateIntegrationReload?.stagedMigration) {
      migration = migrationCompletionResult({
        operationId: job.jobId,
        steps: (job.checkpointResult?._migrationSteps ?? []) as MigrationResult["steps"],
        pendingServiceIds: z
          .array(id)
          .max(256)
          .optional()
          .parse(job.checkpointResult?._migrationPendingServiceIds),
        application: receipt.application,
      });
      if (migration.outcome === "unknown") throw new JobObservationPending("recovery_required");
      await job.checkpoint({ ...job.checkpointResult, migration });
    } else {
      await job.checkpoint({
        ...job.checkpointResult,
        _configurationCandidate: {
          ...(job.checkpointResult?._configurationCandidate as Record<string, unknown>),
          phase: "settled",
        },
      });
    }
    await retireSettledProspectiveConfiguration(candidate);
    return {
      configuration: receipt.application,
      ...(migration ? { migration } : {}),
    };
  }
  try {
    await maintenance.prepareConfigurationMaintenance(candidate);
  } catch (error) {
    const preparation =
      state.record.prepareOperationKey &&
      readProjection(job.protocol, job.checkpointResult).operations[
        state.record.prepareOperationKey
      ];
    if (
      preparation &&
      preparation.terminal &&
      preparation.receiptDelivery !== undefined &&
      ["failed", "timed_out"].includes(preparation.receiptDelivery.terminalReceipt.state)
    )
      return { configuration: await completeNeverPreparedConfiguration(candidate) };
    throw error;
  }
  // The rows were never saved: the prepared maintenance is abandoned unused.
  await maintenance.settleConfigurationMaintenance(state.record.maintenanceId!, "abandon");
  await discardUnusedPreparedProspectiveConfiguration(candidate);
  if (job.protocol?.cancelRequestedAt !== undefined)
    return completeUnusedConfigurationCancellation(candidate);
  const configuration: TrustedConfigurationApplyOutcome = {
    outcome: "not_committed",
    reason: "conflict",
    cleanupFailed: false,
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
  if (overlay.purpose === "migration") {
    if (!state.participant || !isStagedMigrationParticipant(state.participant, writer))
      throw Error("Configuration commit participant unavailable");
    assertStagedMigrationOverlay(writer, overlay);
  }
  if (overlay.purpose === "integration-binding") assertIntegrationBindingOverlay(writer, overlay);
  if (
    overlay.purpose === "migration" &&
    !["configuration-migration", "credential-import"].includes(state.participant?.kind ?? "")
  )
    throw Error("Configuration commit participant unavailable");
  if (overlay.purpose === "platform") assertPlatformConfigurationOverlay(writer, overlay);
  if (
    overlay.changes.some((change) => change.kind === "platform") &&
    overlay.purpose !== "platform" &&
    !(
      overlay.purpose === "migration" &&
      state.participant &&
      isStagedMigrationParticipant(state.participant, writer) &&
      stagedMigrationHasPlatform(writer)
    )
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
        !["transit-credentials", "migration"].includes(overlay.purpose) ||
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
  if (["extension.install", "extension.remove"].includes(owner.job.jobType ?? "")) {
    await advanceCompletedExtensionCandidate(writer);
  }
  const coordinator = input.coordinatorIntent
    ? await assertCoordinatorLifecycleIntent(input.coordinatorIntent, writer)
    : null;
  input.signal?.throwIfAborted();
  const overlay = overlaySchema.parse(input.overlay);
  const platformIntent =
    overlay.purpose === "platform" ||
    (overlay.purpose === "migration" &&
      owner.participant &&
      isStagedMigrationParticipant(owner.participant, writer) &&
      stagedMigrationHasPlatform(writer))
      ? retainedPlatformConfigurationIntent(writer)
      : undefined;
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
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
  const publisher = publisherOptions(token);
  const source = platformIntent
    ? retainedPlatformConfigurationSource(writer)
    : overlay.purpose === "migration" &&
        owner.participant &&
        isStagedMigrationParticipant(owner.participant, writer)
      ? retainedStagedMigrationSource(writer)
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
      const fingerprint = await sourceFingerprint(context);
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
        if ((await sourceFingerprint(context)) !== fingerprint)
          throw Error("Configuration source changed during preparation");
        for (const entry of payload.serviceConfigs) {
          const manifest = context.services.find(
            (service) => service.manifest.id === entry.serviceId,
          )!.manifest;
          if (!coreServices.validateTrustedConfigurationValues(entry.values, manifest.configSchema))
            throw Error("Configuration schema rejected");
        }
        const reused = await reusePreparedCandidate({
          writer,
          operationKey: input.operationKey,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          overlay,
          payload,
          fingerprint,
          source,
          rows: merged,
          sourceRows: context,
          integrationReloadSnapshot,
        });
        if (reused) return reused;
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
                    change.serviceId &&
                    (overlay.purpose !== "migration" ||
                      context.services.some((s) => s.manifest.id === change.serviceId && s.enabled))
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
          (overlay.purpose === "migration" &&
            owner.participant &&
            isStagedMigrationParticipant(owner.participant, writer) &&
            affectedServiceIds.length > 0) ||
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
          (overlay.purpose === "migration" &&
            ["configuration-migration", "credential-import"].includes(
              owner.participant?.kind ?? "",
            ))
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
        const operationForRevision = (revisionId: string, payloadDigest: string): OpsOperation =>
          ({
            kind,
            revisionId,
            payloadDigest,
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
        const sealed = prepareConfigurationCandidate({
          role: "api",
          operationKey: applyOperationKey,
          operationForRevision,
          payload,
          nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
        });
        const record: PreparedConfigurationRecord = {
          version: 1,
          candidateId,
          operationKey: applyOperationKey,
          operation: sealed.operation,
          sourceFingerprint: fingerprint,
          expectedSourceRevision: source.sourceRevision,
          snapshot: sealed.snapshot,
          payload,
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
          ...(apiFollowUp === "integration-reload" ||
          (overlay.purpose === "migration" &&
            owner.participant &&
            isStagedMigrationParticipant(owner.participant, writer))
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
                    ? { stagedMigration: retainedStagedMigration(writer) }
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
          payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
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
        setStage(candidate, "preflight");
        await verifyConfigurationCommitParticipant(candidate, writer);
        assertRowReceiptBudget(
          savedRowIntents(validatedConfigurationCandidateState(candidate)).map((row) => ({
            ...row,
            rowVersion: row.state === "present" ? "4294967295" : null,
          })),
        );
        await retainConfigurationCandidate(record);
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
          assertMaintenanceIntentCapacity(state, owner.job.protocol, owner.job.checkpointResult);
        } catch (error) {
          if (coordinator?.action === "update")
            await closeUnissuedCoordinatorPull(owner.job, candidateId, record.operationKey);
          // Preview is read-only. This exact inert candidate has no apply/guard
          // admission, so a conclusive local refusal may free its reserved queue slot.
          await discardUnadmittedTrustedConfigurationCandidate(candidate);
          setStage(candidate, "discarded");
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
        setStage(candidate, "prepared");
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

/** A rerun of a job step continues with the maintenance candidate the step
 * prepared before a restart, keeping its identifiers and operation keys, as
 * long as its rows were not saved and still build exactly the same payload. */
async function reusePreparedCandidate(input: {
  writer: AdministrativeConfigurationWriter;
  operationKey: string;
  expectedCurrentRevisionId: string | null;
  overlay: Overlay;
  payload: TrustedConfigurationPayload;
  fingerprint: string;
  source: ConfigurationSourcesInspection;
  rows: NonNullable<CandidateState["rows"]>;
  sourceRows: NonNullable<CandidateState["sourceRows"]>;
  integrationReloadSnapshot: CandidateState["integrationReloadSnapshot"];
}): Promise<ValidatedConfigurationCandidate | undefined> {
  const { job } = administrativeConfigurationState(input.writer),
    retained = job.checkpointResult?._configurationCandidate as Record<string, unknown> | undefined;
  if (
    !retained ||
    retained.operationKey !== input.operationKey ||
    typeof retained.maintenanceId !== "string" ||
    typeof retained.sealedOperationKey !== "string" ||
    !["prepared", "save_attempted"].includes(String(retained.phase)) ||
    job.checkpointResult?._configurationMaintenanceDecision !== undefined ||
    job.checkpointResult?._configurationMaintenanceRollback !== undefined
  )
    return undefined;
  const { record, payload, snapshot } = await readConfigurationCandidate(
    retained.sealedOperationKey,
  );
  if (
    record.candidateId !== retained.candidateId ||
    record.maintenanceId !== retained.maintenanceId ||
    record.apiJobId !== job.jobId ||
    record.sourceFingerprint !== input.fingerprint ||
    record.expectedSourceRevision !== input.source.sourceRevision ||
    canonicalJson(record.privateOverlay) !== canonicalJson(input.overlay) ||
    canonicalJson(payload) !== canonicalJson(input.payload)
  )
    throw new JobObservationPending("recovery_required");
  const candidate = Object.freeze({
    candidateId: record.candidateId,
    operationKey: input.operationKey,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    revisionId: snapshot.revisionId,
    sourceFingerprint: record.sourceFingerprint,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    affectedServiceIds: Object.freeze([...record.affectedServiceIds]),
  }) as ValidatedConfigurationCandidate;
  candidates.set(candidate, {
    writer: input.writer,
    overlay: input.overlay,
    payload,
    sealed: {
      revisionId: snapshot.revisionId,
      operation: opsOperationSchema.parse(record.operation),
      operationFingerprint: snapshot.operationFingerprint,
      snapshot,
    },
    record,
    publisher: publisherOptions(await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""))),
    source: input.source,
    preview: configurationHardlinksPreviewSchema.parse(retained.preview),
    rows: input.rows,
    sourceRows: {
      serviceRows: input.sourceRows.serviceRows,
      integrationRows: input.sourceRows.integrationRows,
      serviceSecretRows: input.sourceRows.serviceSecretRows,
      integrationSecretRows: input.sourceRows.integrationSecretRows,
    },
    persisted: false,
    integrationReloadSnapshot: input.integrationReloadSnapshot,
  });
  setStage(candidate, "prepared");
  await verifyConfigurationCommitParticipant(candidate, input.writer);
  return candidate;
}

/** Local count arithmetic only. No future decision body/root is allocated.
 * All exact known middle-owner addresses plus the two original controls must
 * fit the existing shared64 map before helper/pull; later CAS still rechecks. */
function assertMaintenanceIntentCapacity(
  state: CandidateState,
  protocol: unknown,
  result: unknown,
): void {
  const record = state.record;
  if (!record.maintenanceId || !record.prepareOperationKey) return;
  const projection = readProjection(protocol, result),
    keys = new Set<string>([record.prepareOperationKey]);
  const platform = record.privatePlatformIntent;
  const recreate = platform
    ? record.affectedServiceIds.filter(
        (id) => !protectedConfigurationServiceIdSchema.safeParse(id).success,
      )
    : record.apiFollowUp === "service-apply" ||
        record.privateCoordinatorLifecycle ||
        record.privateIntegrationReload?.stagedMigration
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
  if (state.record.privatePlatformIntent && !state.record.privateIntegrationReload?.stagedMigration)
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
  const ordinaryIntents: Array<{
    kind:
      | "platform"
      | "service-config"
      | "integration-config"
      | "service-secret"
      | "integration-secret";
    ownerId: string;
    key?: string;
    rowId: string;
    previousRowVersion: string | null;
    state: "present" | "absent";
  }> = state.overlay.changes.flatMap((change) => {
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
  if (state.record.privatePlatformIntent)
    ordinaryIntents.push({
      kind: "platform",
      ownerId: "platform",
      rowId: "platformConfiguration",
      previousRowVersion: state.record.privatePlatformIntent.expectedDesiredRowVersion,
      state: "present",
    } as (typeof ordinaryIntents)[number]);
  return ordinaryIntents;
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
          patch: isStagedMigrationParticipant(owner.participant, state.writer)
            ? stagedMigrationPatch(state.writer)
            : transitParticipantPatch(owner.participant, state.writer),
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
    state.sealed.snapshot.expiresAt <= new Date().toISOString()
  )
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  await withAdministrativeConfigurationRead({ signal }, async (read) => {
    if ((await sourceFingerprint(read)) !== candidate.sourceFingerprint)
      rejectUnissuedCandidate(candidate, "Configuration source conflict");
  });
  await verifyConfigurationCommitParticipant(candidate, state.writer);
  // Explicit lifecycle candidates observe an already-ready OLD coordinator.
  // In particular never Compose up after Update has staged a new image.
  const beforePull =
    state.record.privateCoordinatorLifecycle?.action === "update"
      ? readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
          state.record.privateCoordinatorLifecycle.pull.operationKey
        ]
      : undefined;
  if (state.record.privateCoordinatorLifecycle && beforePull && beforePull.phase !== "prepared") {
    const helper = readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
      fixed.root.operationKey
    ];
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
  if (state.sealed.snapshot.expiresAt <= new Date().toISOString())
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  await withAdministrativeConfigurationRead({ signal }, async (read) => {
    if ((await sourceFingerprint(read)) !== candidate.sourceFingerprint)
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
    stageOf(candidate) !== "prepared" ||
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
  if (state.sealed.snapshot.expiresAt <= new Date().toISOString())
    rejectUnissuedCandidate(candidate, "Configuration candidate expired");
  const fixedPull =
    state.record.privateCoordinatorLifecycle?.action === "update"
      ? state.record.privateCoordinatorLifecycle.pull
      : undefined;
  const deliverPull = async () => {
    if (!fixedPull) throw Error("Original coordinator Update required");
    try {
      await deliverCoordinatorPullSubmission(owner.job, candidate.candidateId);
    } catch (error) {
      const { ApiOpsError } = await import("./ops-client"),
        pull = readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
          fixedPull.operationKey
        ];
      // Only this fixed delivery's confirmed original failure selects cleanup.
      // The locked nonissuance producer still re-observes its actual ACK and
      // excludes every maintenance/save attempt before removing the packet.
      if (
        error instanceof ApiOpsError &&
        error.errorClass !== "recovery_required" &&
        pull?.phase === "terminal" &&
        pull.terminal &&
        pull.receiptDelivery !== undefined &&
        ["failed", "timed_out"].includes(pull.receiptDelivery.terminalReceipt.state)
      )
        rejectUnissuedCandidate(candidate, "Original coordinator pull failed before maintenance");
      throw error;
    }
  };
  const attemptedPull =
    fixedPull &&
    readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
      fixedPull.operationKey
    ];
  if (attemptedPull && attemptedPull.phase !== "prepared" && attemptedPull.phase !== "unissued") {
    // Reclaim must finish the original lookup/ACK before current inventory
    // can recognize staged ownership. The fixed CAS makes this lookup-only;
    // a fresh PREPARED pull still follows the OLD-coordinator prerequisite.
    await deliverPull();
  }
  await verifyCurrentPreview(candidate, state, signal);
  await prepareMaintenanceCoordinator(candidate, state, signal);
  if (state.record.privateCoordinatorLifecycle?.action === "update") {
    await deliverPull();
    if (state.sealed.snapshot.expiresAt <= new Date().toISOString())
      rejectUnissuedCandidate(candidate, "Configuration candidate expired");
    await verifyCurrentPreview(candidate, state, signal);
  }
}

/** Prepares the maintenance, then saves the desired rows in one transaction
 * with the candidate's `saved` phase and the row versions. That transaction is
 * the only check that the sources did not change and the preparation still
 * holds. A repeat on a saved candidate checks the rows are still the saved ones. */
export async function commitProspectiveConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    record = state.record,
    stage = stageOf(candidate),
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
    await withConfigurationWriteTransaction(state.writer, async (tx) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined;
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.revisionId !== candidate.revisionId ||
        retained.sealedOperationKey !== record.operationKey ||
        retained.maintenanceId !== record.maintenanceId ||
        retained.phase !== "saved"
      )
        throw Error("Original saved maintenance candidate required");
      await assertConfigurationSavedRows(
        tx,
        z.array(configurationSavedRowSchema).max(512).parse(retained.rowVersions),
      );
      observed = result;
    });
    if (!observed) throw new JobObservationPending("recovery_required");
    owner.job.checkpointResult = observed;
    return;
  }
  const prepared = await maintenance.prepareConfigurationMaintenance(candidate),
    checkpoint = candidateCheckpoint(candidate, state);
  await verifyCurrentPreview(candidate, state, owner.job.signal);
  await verifyConfigurationCommitParticipant(candidate, state.writer);
  await owner.job.checkpoint({
    ...owner.job.checkpointResult,
    _configurationCandidate: { ...checkpoint, phase: "save_attempted" },
  });
  setStage(candidate, "save_attempted");
  let committed: Record<string, unknown> | undefined;
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx, context) => {
      const [row] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update"),
        result = row?.result as Record<string, unknown> | undefined,
        retained = result?._configurationCandidate as Record<string, unknown> | undefined;
      if (
        !result ||
        retained?.candidateId !== candidate.candidateId ||
        retained.operationKey !== candidate.operationKey ||
        retained.sealedOperationKey !== record.operationKey ||
        retained.revisionId !== candidate.revisionId ||
        retained.phase !== "save_attempted" ||
        retained.rowVersions !== undefined
      )
        throw Error("Original owned prepared candidate checkpoint required");
      if ((await sourceFingerprint(context)) !== candidate.sourceFingerprint)
        throw Error("Configuration source conflict");
      if (state.sealed.snapshot.expiresAt <= new Date().toISOString())
        throw Error("Configuration candidate expired");
      await verifyConfigurationCommitParticipant(candidate, state.writer);
      await verifyCurrentPreview(candidate, state, owner.job.signal);
      // The preparation still holds, with time left to apply under it.
      const fresh = await maintenance.inspectConfigurationMaintenance(record.maintenanceId!);
      if (
        fresh.state !== "prepared" ||
        fresh.cancelRequestedAt !== null ||
        canonicalJson(fresh.fence) !== canonicalJson(prepared.fence) ||
        Date.now() + MAINTENANCE_APPLY_MARGIN_MS >= fresh.prepare.deadlineAt
      )
        throw Error("Configuration maintenance preparation no longer holds");
      await owner.participant?.commit(candidate, state.writer, tx);
      const rowVersions = await persistOverlay(tx, state, candidate),
        [latest] = await tx
          .select({ result: schema.adminJob.result })
          .from(schema.adminJob)
          .where(jobOwnership(owner.job.jobId, owner.job.execution))
          .for("update");
      if (!latest) throw Error("Configuration job ownership changed");
      committed = {
        ...(latest.result as Record<string, unknown>),
        _configurationCandidate: { ...checkpoint, phase: "saved", rowVersions },
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
      // The transaction's own rollback is known: nothing was saved.
      setStage(candidate, "rolled_back");
      await owner.job.checkpoint({
        ...owner.job.checkpointResult,
        _configurationCandidate: { ...checkpoint, phase: "rolled_back" },
      });
    }
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  if (!committed) throw new JobObservationPending("recovery_required");
  state.persisted = true;
  setStage(candidate, "committed");
  owner.job.checkpointResult = committed;
}

export async function persistAndApplyProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
  options: { coordinatorMode: CoordinatorMode; signal?: AbortSignal },
): Promise<ProspectiveConfigurationReceipt> {
  const state = validatedConfigurationCandidateState(candidate);
  const owner = administrativeConfigurationState(state.writer),
    stage = stageOf(candidate);
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
      recoveredAs(candidate) === "committed"
    )
  )
    throw Error("Configuration commit participant unavailable");
  if (!state.record.maintenanceId && stage === "committed")
    return applyCommittedOrdinaryCandidate(candidate, options.signal);
  if (state.record.maintenanceId) {
    const maintenanceId = state.record.maintenanceId;
    try {
      await commitProspectiveConfigurationMaintenance(candidate);
    } catch (error) {
      // A known rejection before the preparation has nothing to settle; the
      // inert candidate is discarded once nothing was issued.
      if (
        stageOf(candidate) === "prepared" &&
        candidates.get(candidate)?.rejectedUnissued === true &&
        owner.job.checkpointResult?._configurationMaintenance === undefined
      ) {
        await discardUnissuedMaintenanceCandidate(candidate);
        throw new AdminJobFailure("Configuration candidate preflight failed", {
          configuration: {
            outcome: "not_committed",
            reason: "conflict",
            cleanupFailed: false,
            registryUpdateFailed: false,
          },
        });
      }
      const preparation =
        state.record.prepareOperationKey &&
        readProjection(owner.job.protocol, owner.job.checkpointResult).operations[
          state.record.prepareOperationKey
        ];
      if (
        stageOf(candidate) === "prepared" &&
        preparation &&
        preparation.terminal &&
        preparation.receiptDelivery !== undefined &&
        ["failed", "timed_out"].includes(preparation.receiptDelivery.terminalReceipt.state)
      ) {
        await completeNeverPreparedConfiguration(candidate);
        throw error;
      }
      if (!(error instanceof ConfigurationWriteRolledBack) || stageOf(candidate) !== "rolled_back")
        throw error;
      // Nothing was saved: the prepared maintenance is abandoned unused.
      await settleConfigurationMaintenance(maintenanceId, "abandon");
      await discardUnusedPreparedProspectiveConfiguration(candidate);
      const application: TrustedConfigurationApplyOutcome = {
        outcome: "not_committed",
        reason: "conflict",
        cleanupFailed: false,
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
    const { applied, settled } = await applySavedConfigurationMaintenance(candidate);
    // A cancel before the maintenance applied anything leaves the generation as it was.
    if (!applied?.generation) {
      if (settled.generation !== "not_started")
        throw new JobObservationPending("recovery_required");
      throw new AdminJobFailure("Configuration maintenance was cancelled", {
        configuration: {
          outcome: "not_committed",
          reason: "failed",
          cleanupFailed: false,
          registryUpdateFailed: false,
        },
      });
    }
    const generation = configurationApplyResultSchema.parse(applied.generation);
    const contained = generation.outcome === "not_committed" && !generation.cleanupFailed;
    if (
      !contained &&
      (generation.outcome !== "committed" ||
        generation.revisionId !== candidate.revisionId ||
        generation.followUp !== "complete" ||
        generation.cleanupFailed)
    )
      throw new JobObservationPending("recovery_required");
    if (
      contained
        ? settled.generation !== "not_committed" || settled.appliedRevisionId !== null
        : settled.generation !== "committed" || settled.appliedRevisionId !== candidate.revisionId
    )
      throw new JobObservationPending("recovery_required");
    let registryUpdateFailed = false;
    if (generation.outcome === "committed")
      try {
        getServiceRegistry().applyEnabledIds(new Set(generation.enabledServiceIds));
      } catch {
        registryUpdateFailed = true;
      }
    const application: TrustedConfigurationApplyOutcome = {
        ...generation,
        registryUpdateFailed,
      },
      followUp = contained || settled.followUp !== "complete" ? "contained" : "complete",
      checkpoint = owner.job.checkpointResult?._configurationCandidate as Record<string, unknown>,
      rowVersions = z
        .array(configurationSavedRowSchema)
        .max(512)
        .parse(checkpoint?.rowVersions ?? []),
      serviceId = "serviceId" in state.sealed.operation ? state.sealed.operation.serviceId : null;
    await owner.job.checkpoint({
      ...owner.job.checkpointResult,
      _configurationCandidate: {
        ...checkpoint,
        phase: registryUpdateFailed
          ? "unknown"
          : state.record.privateIntegrationReload?.stagedMigration
            ? "saved"
            : "settled",
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
              followUp,
            },
          }
        : {}),
      ...(state.record.privateCoordinatorLifecycle
        ? {
            coordinatorLifecycle: {
              serviceId: "data-manager",
              action: state.record.privateCoordinatorLifecycle.action,
              revisionId: candidate.revisionId,
              followUp,
            },
          }
        : {}),
      ...(state.record.privatePlatformIntent
        ? {
            platformConfiguration: {
              previewFingerprint: state.record.privatePlatformIntent.previewFingerprint,
              handoffId: state.record.privatePlatformIntent.handoffId,
              revisionId: candidate.revisionId,
              followUp,
            },
          }
        : {}),
    });
    // A generation committed with a follow-up that did not complete, as after a
    // cancel, ends the job without success.
    if (!contained && followUp !== "complete")
      throw new AdminJobFailure("Configuration maintenance did not complete", {
        configuration: application,
      });
    if (!registryUpdateFailed && !state.record.privateIntegrationReload?.stagedMigration)
      await retireSettledProspectiveConfiguration(candidate);
    return {
      candidateId: candidate.candidateId,
      revisionId: candidate.revisionId,
      saved: state.record.privateCoordinatorLifecycle
        ? "unchanged"
        : rowVersions.length
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
    setStage(candidate, "discarded");
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
  setStage(candidate, "save_attempted");
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx, context) => {
      if ((await sourceFingerprint(context)) !== candidate.sourceFingerprint)
        throw Error("Configuration source conflict");
      if (state.sealed.snapshot.expiresAt <= new Date().toISOString())
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
      setStage(candidate, "rolled_back");
      await discardUnadmittedTrustedConfigurationCandidate(candidate);
      setStage(candidate, "discarded");
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
          registryUpdateFailed: false,
        },
      };
    }
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  state.persisted = true;
  setStage(candidate, "committed");
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
        .select({ result: schema.adminJob.result, protocol: schema.adminJob.protocol })
        .from(schema.adminJob)
        .where(jobOwnership(owner.job.jobId, owner.job.execution))
        .for("update"),
      result = row?.result as Record<string, unknown> | undefined,
      _protocol = row?.protocol as AdminJobProtocol | undefined,
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
    if (state.record.privateIntegrationReload?.stagedMigration)
      await (await import("./configuration-migration/staging")).assertRetainedMigrationRows(
        {
          previewId: state.record.privateIntegrationReload.stagedMigration.previewId,
          actorId: state.writer.actorId,
          jobId: owner.job.jobId,
          candidateId: state.record.candidateId,
        },
        tx,
      );
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
      payload: state.payload,
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
  const attempted = readProjection(owner.job.protocol, committed).operations[
    state.record.operationKey
  ]?.attempt;
  if (!attempted) await assertConfigurationApplySubmittable(candidate);
  const result = (await execute()) as TrustedConfigurationApplyOutcome;
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
    registryUpdateFailed,
  };
  const phase =
    application.outcome === "unknown" ||
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

/**
 * A committed candidate's apply may be submitted only while its snapshot is
 * current, and every request must expire before it does: after the snapshot
 * expires, recovery may rely on the apply never being admitted.
 */
async function assertConfigurationApplySubmittable(candidate: ValidatedConfigurationCandidate) {
  assertCommittedConfigurationCandidate(candidate);
  const state = validatedConfigurationCandidateState(candidate);
  if (state.record.privatePlatformIntent)
    await verifyConfigurationCommitParticipant(candidate, state.writer);
  if (Date.parse(state.sealed.snapshot.expiresAt) <= Date.now() + OPS_MAX_REQUEST_TTL_MS)
    throw new Error(REJECTED);
}

/** The installed staged preview can discard only its original unissued packet.
 * The existing nonissuance protocol proves there was no remote/save admission. */
export async function discardStagedMigrationPreview(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer);
  if (
    !owner.participant ||
    owner.participant.mode !== "preview" ||
    !isStagedMigrationParticipant(owner.participant, state.writer)
  )
    throw Error("Original staged preview required");
  if (
    state.persisted ||
    Object.values(readProjection(owner.job.protocol, owner.job.checkpointResult).operations).some(
      (entry) =>
        entry.operationKey === state.record.prepareOperationKey ||
        entry.operationKey === state.record.operationKey,
    )
  )
    throw Error("Unadmitted staged preview required");
  setStage(candidate, "preflight");
  return discardUnadmittedTrustedConfigurationCandidate(candidate);
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
    expected = state.checkpoint;
  if (
    typeof expected.sealedOperationKey !== "string" ||
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(expected.sealedOperationKey) ||
    typeof expected.revisionId !== "string" ||
    !/^cfg1_[A-Za-z0-9_-]{43}$/.test(expected.revisionId)
  )
    throw Error(REJECTED);
  let retained: Awaited<ReturnType<typeof findConfigurationCandidate>>;
  try {
    retained = await readConfigurationCandidate(expected.sealedOperationKey);
  } catch (error) {
    if (error instanceof Error && error.message === "Configuration candidate missing") return;
    throw error;
  }
  const { record, snapshot } = retained;
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
  await discardConfigurationCandidate(expected.sealedOperationKey);
}
async function removeExactRetainedCandidate(
  _candidate: ValidatedConfigurationCandidate,
  state: ReturnType<typeof validatedConfigurationCandidateState>,
): Promise<void> {
  const retained = await findConfigurationCandidate(state.record.candidateId);
  // Both callers have already proved this candidate unadmitted or settled.
  if (!retained) return;
  if (canonicalJson(retained.record) !== canonicalJson(state.record)) throw new Error(REJECTED);
  await discardConfigurationCandidate(state.record.operationKey);
}

/** Request correlation only: the receiver restores the SAME admitted root.
 * The original API parent deadline stays exact; only this fixed no-effect
 * metadata attempt receives its own bounded reconciliation clock. */
/** A maintenance settle has its own short deadline, so it can still be sent
 * once the job's parent deadline passed or the job was cancelled. */
function maintenanceSettleRoot(job: JobContext, stepAddress: string) {
  const parent = z
    .strictObject({
      operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      deadlineAt: z.number().int().nonnegative().safe(),
    })
    .parse(job.checkpointResult?._parentExecution);
  if (!job.execution) throw Error("Owned maintenance settlement required");
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
/** The job's maintenance checkpoint: what it prepared and the record it saw last. */
function maintenanceCheckpoint(job: JobContext) {
  return job.checkpointResult?._configurationMaintenance as Record<string, unknown> | undefined;
}
function assertOwnRecord(
  job: JobContext,
  record: MaintenanceRecord,
  prepare: ConfigurationMaintenancePrepare,
  prepareOperationKey: string,
) {
  const { kind: _kind, ...binding } = prepare;
  if (
    canonicalJson(record.binding) !== canonicalJson(binding) ||
    record.prepare.operationKey !== prepareOperationKey ||
    record.prepare.operationFingerprint !== opsOperationFingerprint(prepare) ||
    record.apiJobId !== job.jobId
  )
    throw Error("Configuration maintenance identity changed");
  return record;
}

export async function prepareConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<MaintenanceRecord> {
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
      : record.apiFollowUp === "service-apply" ||
          record.privateCoordinatorLifecycle ||
          record.privateIntegrationReload?.stagedMigration
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
  const retained = maintenanceCheckpoint(job);
  if (
    retained &&
    (retained.prepareOperationKey !== checkpoint.prepareOperationKey ||
      retained.prepareOperationFingerprint !== checkpoint.prepareOperationFingerprint ||
      retained.candidateId !== checkpoint.candidateId)
  )
    throw Error("Original maintenance attempt changed");
  // An attempted preparation is only observed again; it never stages again.
  if (
    !readProjection(job.protocol, job.checkpointResult).operations[record.prepareOperationKey]
      ?.attempt
  )
    await stageProspectiveConfigurationMaintenance(candidate, job.signal);
  if (!retained)
    await job.checkpoint({ ...job.checkpointResult, _configurationMaintenance: checkpoint });
  const prepared = assertOwnRecord(
    job,
    maintenanceRecordSchema.parse(
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
    ),
    operation,
    record.prepareOperationKey,
  );
  if (prepared.state !== "prepared" || prepared.fence?.state !== "prepared")
    throw Error("Original prepared maintenance record required");
  if (maintenanceCheckpoint(job)?.phase === "preparing")
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: { ...checkpoint, phase: "prepared", record: prepared },
    });
  return prepared;
}

/** A read of the maintenance record; it never changes anything at the agent
 * other than recording a helper that exited. */
export async function inspectConfigurationMaintenance(
  maintenanceId: string,
): Promise<MaintenanceRecord> {
  const owner = administrativeConfigurationState(currentAdministrativeConfigurationWriter()),
    { job } = owner,
    retained = maintenanceCheckpoint(job),
    prepared = configurationMaintenancePrepareSchema.parse(retained?.operation);
  if (
    !job.execution ||
    prepared.maintenanceId !== maintenanceId ||
    typeof retained?.prepareOperationKey !== "string"
  )
    throw Error("Original retained maintenance inspection required");
  const parent = z
      .strictObject({
        operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        deadlineAt: z.number().int().nonnegative().safe(),
      })
      .parse(job.checkpointResult?._parentExecution),
    operation = { kind: "configurationMaintenance.inspect" as const, maintenanceId },
    key = createDurableOpsKey(
      "configuration-maintenance.inspect",
      `${job.jobId}:${retained.prepareOperationKey}:${randomUUID()}`,
    ),
    attempt = prepareApiJobChildAttempt(job, operation, key, {
      operationKey: key,
      parent,
      requestedDeadlineAt: Date.now() + 15000,
    });
  if (!attempt) throw Error("Original live API inspection owner required");
  const response = await createApiOpsClient()
    .execute(operation, {
      operationKey: key,
      signal: AbortSignal.any([job.signal, AbortSignal.timeout(15000)]),
      execution: { requestedDeadlineAt: attempt.requestedDeadlineAt },
      parentAssertion: issueApiJobChildAssertion(attempt),
    })
    .catch((error: unknown) => {
      // An unanswered inspection proves nothing; the job observes again later.
      if (error instanceof OpsClientError) {
        if (["runtime", "timeout", "busy"].includes(error.errorClass))
          throw new JobObservationPending("transport");
        if (error.errorClass === "recovery_required")
          throw new JobObservationPending("recovery_required");
      }
      throw error;
    });
  if (response.execution !== "sync") throw Error("Original maintenance inspection unavailable");
  return assertOwnRecord(
    job,
    maintenanceRecordSchema.parse(response.value),
    prepared,
    retained.prepareOperationKey,
  );
}

/** Runs the maintenance's steps at the agent. It returns once the steps the
 * agent runs itself ended; a handoff may still run then. */
async function applyConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<OpsResultFor<"configurationMaintenance.apply">> {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    maintenanceId = state.record.maintenanceId!,
    retained = maintenanceCheckpoint(job);
  if (!retained || retained.maintenanceId !== maintenanceId)
    throw Error("Original prepared maintenance required");
  if (retained.phase === "prepared")
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: { ...retained, phase: "applying" },
    });
  return executeAdminJobOperation(
    job,
    { kind: "configurationMaintenance.apply", maintenanceId },
    "configuration-maintenance.apply",
    { durableIdentity: maintenanceId },
  );
}

/** Settles the maintenance: `complete` once no step is unresolved, `abandon`
 * before any step started or, once one did, to stop it after the step in
 * flight. Each outcome has its own key; a repeat returns the same record. */
export async function settleConfigurationMaintenance(
  maintenanceId: string,
  outcome: "complete" | "abandon",
): Promise<MaintenanceRecord> {
  const { job } = administrativeConfigurationState(currentAdministrativeConfigurationWriter());
  return settleJobMaintenance(job, maintenanceId, outcome);
}

/** A cancel that arrives after the agent's `apply` returned, while its helper
 * may still replace services, stops the maintenance at once: the helper ends
 * the target in flight and starts no other. The job stays pending until the
 * steps are terminal; its next run settles the maintenance. */
export async function abandonAppliedConfigurationMaintenance(job: JobContext): Promise<void> {
  const retained = maintenanceCheckpoint(job);
  if (retained?.phase !== "applying") return;
  const { maintenanceId } = configurationMaintenancePrepareSchema.parse(retained.operation);
  const applied = Object.values(readProjection(job.protocol, job.checkpointResult).operations).some(
    (operation) =>
      operation.kind === "configurationMaintenance.apply" &&
      operation.terminal &&
      (operation.result as { outcome?: unknown } | undefined)?.outcome === "running",
  );
  if (applied) await settleJobMaintenance(job, maintenanceId, "abandon");
}

async function settleJobMaintenance(
  job: JobContext,
  maintenanceId: string,
  outcome: "complete" | "abandon",
): Promise<MaintenanceRecord> {
  const retained = maintenanceCheckpoint(job),
    prepared = configurationMaintenancePrepareSchema.parse(retained?.operation);
  if (prepared.maintenanceId !== maintenanceId || typeof retained?.prepareOperationKey !== "string")
    throw Error("Original prepared maintenance required");
  const stepAddress = createDurableOpsKey(
      "configuration-maintenance.settle",
      `${job.jobId}:${maintenanceId}:${outcome}`,
    ),
    retainedRoot = readProjection(job.protocol, job.checkpointResult).steps[stepAddress],
    root = retainedRoot ? undefined : maintenanceSettleRoot(job, stepAddress);
  const record = assertOwnRecord(
    job,
    maintenanceRecordSchema.parse(
      await executeAdminJobOperation(
        job,
        { kind: "configurationMaintenance.settle", maintenanceId, outcome },
        "configuration-maintenance.settle",
        { operationKey: stepAddress, ...(root ? { preparedRoot: root } : {}) },
      ),
    ),
    prepared,
    retained.prepareOperationKey,
  );
  if (record.state === "settled")
    await job.checkpoint({
      ...job.checkpointResult,
      _configurationMaintenance: { ...maintenanceCheckpoint(job), phase: "settled", record },
      _configurationMaintenanceSettle: maintenanceSettleCheckpointSchema.parse({
        operationKey: readProjection(job.protocol, job.checkpointResult).steps[stepAddress]
          ?.operationKey,
        outcome,
      }),
    });
  return record;
}

/** Applies a saved maintenance candidate: every step at the agent, then, once
 * the handoff (if any) ended, the settlement. A cancel stops the maintenance
 * after the step in flight; the job then ends without success. */
async function applySavedConfigurationMaintenance(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    maintenanceId = state.record.maintenanceId!;
  const cancelled = () => job.protocol?.cancelRequestedAt !== undefined;
  let applied: OpsResultFor<"configurationMaintenance.apply"> | undefined;
  if (!cancelled()) applied = await applyConfigurationMaintenance(candidate);
  let record = applied?.record ?? (await inspectConfigurationMaintenance(maintenanceId));
  let cancelSent = false;
  for (;;) {
    if (record.state === "recovery_required") throw new JobObservationPending("recovery_required");
    const unresolved = record.steps.some((step) => step.state === "attempted");
    if (cancelled() && !cancelSent && record.state === "applying" && unresolved) {
      record = await settleConfigurationMaintenance(maintenanceId, "abandon");
      cancelSent = true;
      continue;
    }
    if (!unresolved) break;
    job.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    record = await inspectConfigurationMaintenance(maintenanceId);
  }
  const settled = await settleConfigurationMaintenance(
    maintenanceId,
    record.state === "prepared" ? "abandon" : "complete",
  );
  if (settled.state !== "settled") throw new JobObservationPending("transport");
  return { applied, settled };
}

const configurationMaintenanceProtocol = Object.freeze({
  prepareConfigurationMaintenance,
  inspectConfigurationMaintenance,
  settleConfigurationMaintenance,
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

/** Successive installer configuration phases retain all original ops/ACKs. Only
 * a completed ordinary candidate in the authenticated same-job cursor advances. */
async function advanceCompletedExtensionCandidate(
  writer: import("./administrative-configuration-writer-owner").AdministrativeConfigurationWriter,
) {
  const { job } = administrativeConfigurationState(writer);
  const current = job.checkpointResult?._configurationCandidate as
    | Record<string, unknown>
    | undefined;
  if (!current || current.operationKey === writer.operationKey) return;
  const frame = await readExtensionWorkflow(job.checkpointResult?._extensionWorkflow);
  if (
    frame.jobId !== job.jobId ||
    frame.type !== job.jobType ||
    job.observationOnly ||
    current.maintenanceId
  )
    throw new JobObservationPending("recovery_required");
  const payload = job.payload as {
    manifest?: { id?: string; services?: Array<{ service: string }> };
    id?: string;
  };
  const id = payload.manifest?.id ?? payload.id;
  if (!id) throw new JobObservationPending("recovery_required");
  const allowed = new Set([
    createDurableOpsKey("extension.selection.enable", `${job.jobId}:${id}`),
    createDurableOpsKey("extension.config.render", `${job.jobId}:${id}`),
    createDurableOpsKey("extension.selection.disable", `${job.jobId}:${id}`),
    createDurableOpsKey("extension.remove.render", `${job.jobId}:${id}`),
    createDurableOpsKey("extension.selection.rollback", job.jobId),
    createDurableOpsKey("extension.rollback.render", job.jobId),
    ...(payload.manifest?.services ?? []).flatMap((s) =>
      ["start", "extension-restore"].map((scope) =>
        createDurableOpsKey("admin-job.config.prepare", `${job.jobId}:${scope}:${s.service}`),
      ),
    ),
  ]);
  if (!allowed.has(String(current.operationKey)) || !allowed.has(writer.operationKey))
    throw new JobObservationPending("recovery_required");
  let committed: Record<string, unknown> | undefined;
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
      throw new JobObservationPending("recovery_required");
    const result = (row.result ?? {}) as Record<string, unknown>;
    const protocol = row.protocol as AdminJobProtocol;
    if (
      canonicalJson(await readExtensionWorkflow(result._extensionWorkflow)) !==
        canonicalJson(frame) ||
      canonicalJson(result._configurationCandidate) !== canonicalJson(current) ||
      current.phase !== "settled" ||
      hasUnsettledManagedOperation(result, protocol)
    )
      throw new JobObservationPending("recovery_required");
    const outcome = parseTrustedConfigurationApplyOutcome(
      (result._configurationOutcomes as Record<string, unknown>)?.[String(current.operationKey)],
    );
    if (
      !completeTrustedConfigurationApply(outcome) ||
      outcome.outcome !== "committed" ||
      outcome.revisionId !== current.revisionId
    )
      throw new JobObservationPending("recovery_required");
    committed = { ...result };
    for (const field of ["_configurationCandidate", "_completion"]) delete committed[field];
    const rows = await tx
      .update(schema.adminJob)
      .set({ result: committed })
      .where(jobOwnership(job.jobId, job.execution))
      .returning({ id: schema.adminJob.id });
    if (rows.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (committed) job.checkpointResult = committed;
}
