import { createHash, randomUUID } from "node:crypto";
import {
  type IntegrationApplyReceipt,
  integrationApplyReceiptSchema,
} from "@openmapx/core/api-contracts";
import { controlChildOperationKey } from "@openmapx/core/build-artifacts";
import {
  type ConfigurationHardlinksPreview,
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
  OpsClientError,
  type OpsOperation,
  type OpsResultFor,
  opsOperationFingerprint,
  opsOperationSchema,
  type PreparedConfigurationRecord,
  parseControlRootOperationKey,
  prepareConfigurationCandidate,
  protectedConfigurationServiceIdSchema,
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
import { apiKeyedDigest } from "./admin-job-digest";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  deliverCoordinatorPullSubmission,
  executeAdminJobOperation,
  prepareAdminJobOperationRoot,
  readProjection,
  reserveCoordinatorPullSubmission,
} from "./admin-job-ops";
import { issueApiJobChildAssertion, prepareApiJobChildAttempt } from "./admin-job-parent";
import {
  type AdminJobCandidate,
  type CandidatePhase,
  cancelRequestedAt,
  JobOwnershipLost,
  jobOwnership,
  readAdminJobProtocol,
  writeAdminJobCandidate,
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
  retainConfigurationCandidate,
} from "./configuration-candidate-store";
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
import type { ConfigurationSavedRow } from "./configuration-saved-rows";
import {
  assertCoordinatorLifecycleIntent,
  assertRetainedCoordinatorLifecycleProvenance,
  type CoordinatorLifecycleIntent,
  closeUnissuedCoordinatorPull,
} from "./coordinator-lifecycle";
import {
  assertIntegrationBindingOverlay,
  assertSavedIntegrationBinding,
} from "./integration-binding-participant";
import { capturedBindingState } from "./integration-binding-state";
import { integrationConfigRevision } from "./integration-runtime-evidence";
import type { JobContext } from "./job-runner";
import { ApiOpsError, createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
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
/**
 * A prepared configuration candidate. The job's `protocol.candidate` is its
 * durable state; the agent holds the full record (payload, overlay, apply
 * operation, private intents) under `sealedOperationKey`.
 */
export interface ValidatedConfigurationCandidate {
  readonly candidateId: string;
  readonly operationKey: string;
  readonly expectedCurrentRevisionId: string | null;
  readonly revisionId: string;
  readonly sourceFingerprint: string;
  readonly payloadBytes: number;
  readonly affectedServiceIds: readonly string[];
  readonly state: CandidateState;
}
export type ProspectiveConfigurationReceipt = {
  candidateId: string;
  revisionId: string;
  saved: "unchanged" | "committed" | "conflict" | "unknown";
  application: TrustedConfigurationApplyOutcome;
};
type CandidateRows = Pick<
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
>;
type CandidateSourceRows = Pick<
  AdministrativeConfigurationReadContext,
  "serviceRows" | "integrationRows" | "serviceSecretRows" | "integrationSecretRows"
>;
export interface CandidateState {
  writer: AdministrativeConfigurationWriter;
  overlay: Overlay;
  payload: TrustedConfigurationPayload;
  /** The apply operation sealed with the payload. */
  operation: OpsOperation;
  record: PreparedConfigurationRecord;
  source: ConfigurationSourcesInspection | null;
  preview?: ConfigurationHardlinksPreview;
  /** The desired rows to save and the rows they replace (with row versions). */
  rows: CandidateRows | null;
  sourceRows: CandidateSourceRows | null;
  integrationReloadSnapshot: NonNullable<
    AdministrativeConfigurationReadContext["integrationReloadSnapshot"]
  > | null;
  phase: CandidatePhase;
  /** A rerun found the sources changed since the candidate was prepared. */
  stale?: boolean;
  /** The maintenance record the agent prepared for this candidate. */
  prepared?: MaintenanceRecord;
}
/** A preparation this close to its deadline is not saved under: its apply could
 * not be admitted any more, and the rows would wait for a maintenance that ends. */
const MAINTENANCE_APPLY_MARGIN_MS = 60_000;
/** Purposes whose save runs a participant's commit; only the forward path has it. */
const PARTICIPANT_PURPOSES = ["migration", "transit-credentials", "platform"];
/** A refusal known before any maintenance admission: nothing to settle. */
class CandidateRefused extends Error {}

export function validatedConfigurationCandidateState(
  candidate: ValidatedConfigurationCandidate,
): CandidateState {
  const state = candidate.state;
  if (currentAdministrativeConfigurationWriter() !== state.writer)
    throw Error("Configuration candidate unavailable");
  administrativeConfigurationState(state.writer);
  return state;
}
function createCandidate(input: {
  writer: AdministrativeConfigurationWriter;
  operationKey: string;
  record: PreparedConfigurationRecord;
  payload: TrustedConfigurationPayload;
  revisionId: string;
  overlay: Overlay;
  phase: CandidatePhase;
  source: ConfigurationSourcesInspection | null;
  preview?: ConfigurationHardlinksPreview;
  rows?: CandidateRows | null;
  sourceRows?: CandidateSourceRows | null;
  integrationReloadSnapshot?: CandidateState["integrationReloadSnapshot"];
}): ValidatedConfigurationCandidate {
  const operation = opsOperationSchema.parse(input.record.operation);
  freeze(input.record);
  freeze(input.overlay);
  freeze(input.payload);
  freeze(operation);
  return Object.freeze({
    candidateId: input.record.candidateId,
    operationKey: input.operationKey,
    expectedCurrentRevisionId:
      "expectedCurrentRevisionId" in operation ? operation.expectedCurrentRevisionId : null,
    revisionId: input.revisionId,
    sourceFingerprint: input.record.sourceFingerprint,
    payloadBytes: Buffer.byteLength(JSON.stringify(input.payload)),
    affectedServiceIds: Object.freeze([...input.record.affectedServiceIds]),
    state: {
      writer: input.writer,
      overlay: input.overlay,
      payload: input.payload,
      operation,
      record: input.record,
      source: input.source,
      preview: input.preview,
      rows: input.rows ?? null,
      sourceRows: input.sourceRows ?? null,
      integrationReloadSnapshot: input.integrationReloadSnapshot ?? null,
      phase: input.phase,
    },
  });
}
/** The source a candidate was prepared from, where its record keeps one. */
function retainedSource(record: PreparedConfigurationRecord) {
  return (
    record.privateCoordinatorSource ??
    record.privatePlatformIntent?.sourceSnapshot ??
    record.privateMaintenancePreparation?.source ??
    null
  );
}
/** A job the API ran for an HTTP request; only its intent's digest is kept. */
function isImmediateJob(job: JobContext): boolean {
  return typeof job.checkpointResult?._immediateIntentDigest === "string";
}
function protocolCandidate(job: JobContext): AdminJobCandidate | undefined {
  return readAdminJobProtocol(job.protocol).candidate;
}
function candidateProtocol(
  candidate: ValidatedConfigurationCandidate,
  phase: CandidatePhase,
  rowVersions?: ConfigurationSavedRow[],
): AdminJobCandidate {
  const { record, overlay, preview } = candidate.state;
  return {
    phase,
    candidateId: candidate.candidateId,
    operationKey: candidate.operationKey,
    sealedOperationKey: record.operationKey,
    revisionId: candidate.revisionId,
    sourceFingerprint: candidate.sourceFingerprint,
    maintenanceId: record.maintenanceId,
    coordinatorMode: overlay.coordinatorMode,
    ...(preview ? { preview } : {}),
    ...(rowVersions ? { rowVersions } : {}),
  };
}
/** Moves the candidate to its next phase (outside the rows' transaction). */
async function writePhase(
  candidate: ValidatedConfigurationCandidate,
  phase: CandidatePhase,
): Promise<void> {
  const state = candidate.state,
    { job, connection } = administrativeConfigurationState(state.writer),
    rowVersions = protocolCandidate(job)?.rowVersions as ConfigurationSavedRow[] | undefined;
  job.protocol = await writeAdminJobCandidate(
    connection,
    job.jobId,
    job.execution,
    candidateProtocol(candidate, phase, rowVersions),
  );
  state.phase = phase;
}
/** Reads the candidate back from the agent. Undefined when the agent no longer holds it. */
async function restoreCandidate(
  writer: AdministrativeConfigurationWriter,
  retained: AdminJobCandidate,
): Promise<ValidatedConfigurationCandidate | undefined> {
  const { job } = administrativeConfigurationState(writer),
    found = await findConfigurationCandidate(retained.candidateId);
  if (!found) return undefined;
  const { record, payload, snapshot } = found;
  if (
    record.apiJobId !== job.jobId ||
    record.operationKey !== retained.sealedOperationKey ||
    snapshot.revisionId !== retained.revisionId
  )
    throw new JobObservationPending("invalid_identity");
  return createCandidate({
    writer,
    operationKey: retained.operationKey,
    record,
    payload,
    revisionId: snapshot.revisionId,
    overlay: overlaySchema.parse(record.privateOverlay),
    phase: retained.phase,
    source: retainedSource(record),
    preview:
      retained.preview === undefined
        ? undefined
        : configurationHardlinksPreviewSchema.parse(retained.preview),
  });
}
/** The rows a restored candidate saves: its overlay over the current rows. The
 * save checks the sources are still the ones it was prepared from. */
async function loadCandidateRows(candidate: ValidatedConfigurationCandidate): Promise<void> {
  const state = candidate.state;
  await withAdministrativeConfigurationRead({}, async (context) => {
    state.rows = await mergeOverlay(context, state.overlay, state.source ?? undefined);
    state.sourceRows = {
      serviceRows: context.serviceRows,
      integrationRows: context.integrationRows,
      serviceSecretRows: context.serviceSecretRows,
      integrationSecretRows: context.integrationSecretRows,
    };
    state.integrationReloadSnapshot = state.record.privateIntegrationReload?.values ?? null;
  });
}
function notCommitted(reason: "conflict" | "failed" | "busy"): TrustedConfigurationApplyOutcome {
  return { outcome: "not_committed", reason, cleanupFailed: false, registryUpdateFailed: false };
}
/** Records the step's outcome and that it carries no open candidate any more. A
 * cancelled job ends cancelled. */
async function concludeWithoutChange(
  job: JobContext,
  operationKey: string,
  configuration: TrustedConfigurationApplyOutcome,
): Promise<void> {
  const { connection } = administrativeConfigurationState(
    currentAdministrativeConfigurationWriter(),
  );
  await job.checkpoint({
    ...job.checkpointResult,
    configuration,
    _configurationOutcomes: {
      ...(job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
      [operationKey]: configuration,
    },
  });
  job.protocol = await writeAdminJobCandidate(connection, job.jobId, job.execution, null);
  if (cancelRequestedAt(job.protocol) !== undefined) {
    const result = { ...job.checkpointResult };
    delete result.observation;
    const rows = await connection
      .update(schema.adminJob)
      .set({ status: "canceled", finishedAt: new Date(), result })
      .where(jobOwnership(job.jobId, job.execution, ["running", "cancel_pending"]))
      .returning({ id: schema.adminJob.id });
    if (rows.length !== 1) throw new JobOwnershipLost();
  }
}
/**
 * Gives up a candidate whose rows were not saved: a prepared maintenance is
 * settled `abandon` (unused), a coordinator pull never sent is closed, and the
 * agent drops the record.
 */
async function abandonCandidate(
  candidate: ValidatedConfigurationCandidate,
  reason: "conflict" | "failed" | "busy",
): Promise<ProspectiveConfigurationReceipt> {
  const state = candidate.state,
    { job } = administrativeConfigurationState(state.writer),
    record = state.record;
  if (state.phase !== "candidate_prepared") throw new JobObservationPending("recovery_required");
  if (
    record.maintenanceId &&
    record.prepareOperationKey &&
    readProjection(job.protocol).operations[record.prepareOperationKey]
  ) {
    let prepared: MaintenanceRecord | undefined;
    try {
      prepared = await prepareConfigurationMaintenance(candidate);
    } catch (error) {
      if (!preparationRefused(job, record)) throw error;
    }
    if (prepared) await settleConfigurationMaintenance(record.maintenanceId, "abandon");
  }
  if (record.privateCoordinatorLifecycle?.action === "update")
    await closeUnissuedCoordinatorPull(job, candidate.candidateId, record.operationKey);
  await discardConfigurationCandidate(record.operationKey);
  const application = notCommitted(reason);
  await concludeWithoutChange(job, candidate.operationKey, application);
  return {
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    saved: "conflict",
    application,
  };
}
/** Whether the agent refused the maintenance preparation with a known outcome. */
function preparationRefused(job: JobContext, record: PreparedConfigurationRecord): boolean {
  const entry = record.prepareOperationKey
    ? readProjection(job.protocol).operations[record.prepareOperationKey]
    : undefined;
  return (
    !!entry?.terminal &&
    (entry.phase === "terminal" || entry.phase === "refused") &&
    entry.errorClass !== undefined &&
    entry.errorClass !== "recovery_required"
  );
}

/**
 * Carries a candidate from its phase to the end: prepare its maintenance and
 * save the rows (`rows_saved`), apply (`generation_applied`), finish. A rerun
 * after a restart runs the same code from the phase the job recorded.
 */
export async function persistAndApplyProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
  options: { coordinatorMode: CoordinatorMode; signal?: AbortSignal },
): Promise<ProspectiveConfigurationReceipt> {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer),
    { job } = owner;
  if (
    options.coordinatorMode !== state.overlay.coordinatorMode ||
    owner.participant?.mode === "preview"
  )
    throw Error("Configuration candidate persistence refused");
  if (state.phase === "candidate_prepared") {
    if (cancelRequestedAt(job.protocol) !== undefined) return abandonCandidate(candidate, "failed");
    if (state.stale) return abandonCandidate(candidate, "conflict");
    if (PARTICIPANT_PURPOSES.includes(state.overlay.purpose) && !owner.participant)
      throw Error("Configuration commit participant unavailable");
    if (state.record.maintenanceId) {
      try {
        await prepareMaintenance(candidate);
      } catch (error) {
        if (preparationRefused(job, state.record)) {
          // The agent settled the refused preparation itself.
          await discardConfigurationCandidate(state.record.operationKey);
          await concludeWithoutChange(
            job,
            candidate.operationKey,
            notCommitted(
              error instanceof ApiOpsError && error.errorClass === "busy" ? "busy" : "failed",
            ),
          );
          throw error;
        }
        if (!(error instanceof CandidateRefused)) throw error;
        await abandonCandidate(candidate, "conflict");
        throw new AdminJobFailure("Configuration candidate preflight failed", {
          configuration: notCommitted("conflict"),
        });
      }
    }
    // A participant whose intent went stale since the preparation refuses with
    // its own conflict before the save; nothing is saved.
    if (owner.participant)
      try {
        await owner.participant.verify(candidate, state.writer);
      } catch (error) {
        await abandonCandidate(candidate, "conflict");
        throw error;
      }
    if (!(await savePhase(candidate))) return abandonCandidate(candidate, "conflict");
  }
  if (state.phase === "rows_saved") await applyPhase(candidate);
  const application = parseTrustedConfigurationApplyOutcome(
    (job.checkpointResult?._configurationOutcomes as Record<string, unknown> | undefined)?.[
      candidate.operationKey
    ],
  );
  const followUpPending =
    completeTrustedConfigurationApply(application) &&
    (!!state.record.privateIntegrationReload?.stagedMigration ||
      (!state.record.maintenanceId && state.record.apiFollowUp !== "none"));
  if (state.phase === "generation_applied" && !followUpPending)
    await retireSettledProspectiveConfiguration(candidate);
  const rowVersions = (protocolCandidate(job)?.rowVersions ?? []) as unknown[];
  return {
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    saved:
      state.record.privateCoordinatorLifecycle || rowVersions.length === 0
        ? "unchanged"
        : "committed",
    application,
  };
}

/** Before the first preparation attempt: the coordinator pull and the
 * old-revision coordinator prerequisite; then the agent's preparation. */
async function prepareMaintenance(candidate: ValidatedConfigurationCandidate): Promise<void> {
  const state = candidate.state,
    { job } = administrativeConfigurationState(state.writer),
    record = state.record;
  if (!readProjection(job.protocol).operations[record.prepareOperationKey!]?.attempt) {
    const pull =
      record.privateCoordinatorLifecycle?.action === "update"
        ? record.privateCoordinatorLifecycle.pull
        : undefined;
    const deliverPull = async () => {
      try {
        await deliverCoordinatorPullSubmission(job, candidate.candidateId);
      } catch (error) {
        const entry = readProjection(job.protocol).operations[pull!.operationKey];
        if (
          error instanceof ApiOpsError &&
          error.errorClass !== "recovery_required" &&
          entry?.phase === "terminal" &&
          entry.errorClass
        )
          throw new CandidateRefused("Original coordinator pull failed before maintenance");
        throw error;
      }
    };
    const attemptedPull = pull && readProjection(job.protocol).operations[pull.operationKey];
    // A pull sent before a restart is observed before the coordinator's state is read.
    if (attemptedPull && attemptedPull.phase !== "prepared" && attemptedPull.phase !== "unissued")
      await deliverPull();
    await prepareMaintenanceCoordinator(candidate, state);
    if (pull) await deliverPull();
  }
  state.prepared = await prepareConfigurationMaintenance(candidate);
}

/** The one save: in a single transaction, check the sources and the prepared
 * maintenance, write the rows and move the candidate to `rows_saved`. False
 * when the transaction rolled back (nothing saved). */
async function savePhase(candidate: ValidatedConfigurationCandidate): Promise<boolean> {
  const state = candidate.state,
    owner = administrativeConfigurationState(state.writer),
    { job } = owner,
    record = state.record;
  if (!state.rows || !state.sourceRows) await loadCandidateRows(candidate);
  let saved: Awaited<ReturnType<typeof writeAdminJobCandidate>> | undefined;
  try {
    await withConfigurationWriteTransaction(state.writer, async (tx, context) => {
      const [row] = await tx
          .select({ protocol: schema.adminJob.protocol })
          .from(schema.adminJob)
          .where(jobOwnership(job.jobId, job.execution))
          .for("update"),
        protocol = readAdminJobProtocol(row?.protocol),
        retained = protocol.candidate;
      if (
        !row ||
        retained?.candidateId !== candidate.candidateId ||
        retained.phase !== "candidate_prepared" ||
        cancelRequestedAt(protocol) !== undefined
      )
        throw Error("Configuration job ownership changed");
      if ((await sourceFingerprint(context)) !== candidate.sourceFingerprint)
        throw Error("Configuration source conflict");
      if (Date.parse(record.snapshot.expiresAt) <= Date.now())
        throw Error("Configuration candidate expired");
      if (record.maintenanceId) {
        // The preparation still holds, with time left to apply under it.
        const fresh = await inspectConfigurationMaintenance(record.maintenanceId);
        if (
          fresh.state !== "prepared" ||
          fresh.cancelRequestedAt !== null ||
          canonicalJson(fresh.fence) !== canonicalJson(state.prepared?.fence) ||
          Date.now() + MAINTENANCE_APPLY_MARGIN_MS >= fresh.prepare.deadlineAt
        )
          throw Error("Configuration maintenance preparation no longer holds");
      }
      await owner.participant?.commit(candidate, state.writer, tx);
      const rowVersions = await persistOverlay(tx, state, candidate);
      saved = await writeAdminJobCandidate(
        tx,
        job.jobId,
        job.execution,
        candidateProtocol(candidate, "rows_saved", rowVersions),
        ["running"],
      );
    });
  } catch (error) {
    if (error instanceof ConfigurationWriteRolledBack) return false;
    if (error instanceof ConfigurationWriteCommitUnknown)
      throw new JobObservationPending("recovery_required");
    throw error;
  }
  if (!saved) throw new JobObservationPending("recovery_required");
  job.protocol = saved;
  state.phase = "rows_saved";
  return true;
}

/** Applies saved rows and records the outcome, then `generation_applied`. */
async function applyPhase(candidate: ValidatedConfigurationCandidate): Promise<void> {
  const state = candidate.state,
    { job } = administrativeConfigurationState(state.writer),
    record = state.record;
  const recordOutcome = async (
    application: TrustedConfigurationApplyOutcome,
    extra: Record<string, unknown> = {},
  ) => {
    await job.checkpoint({
      ...job.checkpointResult,
      configuration: application,
      _configurationOutcomes: {
        ...(job.checkpointResult?._configurationOutcomes as Record<string, unknown>),
        [candidate.operationKey]: application,
      },
      ...extra,
    });
  };
  const registry = (application: { outcome: string; enabledServiceIds?: string[] }) => {
    if (application.outcome !== "committed") return false;
    try {
      getServiceRegistry().applyEnabledIds(new Set(application.enabledServiceIds));
      return false;
    } catch {
      return true;
    }
  };
  if (!record.maintenanceId) {
    const result = (await executeAdminJobOperation(
      job,
      state.operation,
      "admin-job.configuration",
      {
        operationKey: candidate.operationKey,
        payload: state.payload,
        preparedRoot: {
          operationKey: record.operationKey,
          requestedDeadlineAt: parseControlRootOperationKey(record.operationKey).notAfter,
          parent: {
            operationKey: record.parentOperationKey,
            fingerprint: record.parentFingerprint,
            deadlineAt: record.parentDeadlineAt,
          },
        },
      },
    )) as TrustedConfigurationApplyOutcome;
    const application = { ...result, registryUpdateFailed: registry(result) };
    await recordOutcome(application);
    // An apply whose outcome the agent does not know is observed again.
    if (application.outcome !== "unknown") await writePhase(candidate, "generation_applied");
    return;
  }
  const { applied, settled } = await applySavedConfigurationMaintenance(candidate);
  // A cancel before the maintenance applied anything leaves the generation as it was.
  if (!applied?.generation) {
    if (settled.generation !== "not_started") throw new JobObservationPending("recovery_required");
    await recordOutcome(notCommitted("failed"));
    await writePhase(candidate, "generation_applied");
    await retireSettledProspectiveConfiguration(candidate);
    throw new AdminJobFailure("Configuration maintenance was cancelled", {
      configuration: notCommitted("failed"),
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
  const application: TrustedConfigurationApplyOutcome = {
      ...generation,
      registryUpdateFailed: registry(generation),
    },
    followUp = contained || settled.followUp !== "complete" ? "contained" : "complete",
    serviceId = "serviceId" in state.operation ? state.operation.serviceId : null;
  await recordOutcome(application, {
    ...(record.apiFollowUp === "service-apply" && serviceId
      ? { serviceCredential: { serviceId, revisionId: candidate.revisionId, followUp } }
      : {}),
    ...(record.privateCoordinatorLifecycle
      ? {
          coordinatorLifecycle: {
            serviceId: "data-manager",
            action: record.privateCoordinatorLifecycle.action,
            revisionId: candidate.revisionId,
            followUp,
          },
        }
      : {}),
    ...(record.privatePlatformIntent
      ? {
          platformConfiguration: {
            previewFingerprint: record.privatePlatformIntent.previewFingerprint,
            handoffId: record.privatePlatformIntent.handoffId,
            revisionId: candidate.revisionId,
            followUp,
          },
        }
      : {}),
  });
  await writePhase(candidate, "generation_applied");
  // A generation committed with a follow-up that did not complete, as after a
  // cancel, ends the job without success.
  if (!contained && followUp !== "complete") {
    await retireSettledProspectiveConfiguration(candidate);
    throw new AdminJobFailure("Configuration maintenance did not complete", {
      configuration: application,
    });
  }
}

/** Finishes an applied candidate: a platform preview is retired and the agent
 * drops the record. Repeating it changes nothing. */
export async function retireSettledProspectiveConfiguration(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    fixed = state.record.privatePlatformIntent;
  if (state.phase !== "generation_applied") throw Error("Applied configuration candidate required");
  if (fixed)
    await withConfigurationWriteTransaction(state.writer, async (tx) => {
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
  await discardConfigurationCandidate(state.record.operationKey);
}

/**
 * Continues the job's candidate for the writer's operation key after a restart,
 * from the phase the job recorded. Before `rows_saved` an immediate job (its
 * HTTP caller is gone, its intent not kept) and a cancelled job give the
 * candidate up; a queued job continues. From `rows_saved` on every job
 * finishes the apply and its follow-ups.
 */
export async function resumeConfigurationCandidate(): Promise<Record<string, unknown>> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer),
    retained = protocolCandidate(job);
  if (!retained) {
    const configuration = notCommitted("failed");
    await concludeWithoutChange(job, writer.operationKey, configuration);
    return { configuration };
  }
  if (retained.operationKey !== writer.operationKey)
    throw new JobObservationPending("recovery_required");
  const candidate = await restoreCandidate(writer, retained);
  if (!candidate) {
    if (retained.phase === "candidate_prepared") {
      const configuration = notCommitted("conflict");
      await concludeWithoutChange(job, writer.operationKey, configuration);
      return { configuration };
    }
    if (retained.phase === "generation_applied")
      return {
        configuration: (job.checkpointResult?._configurationOutcomes as Record<string, unknown>)?.[
          writer.operationKey
        ],
      };
    throw new JobObservationPending("recovery_required");
  }
  const state = candidate.state;
  if (
    state.phase === "candidate_prepared" &&
    (isImmediateJob(job) ||
      PARTICIPANT_PURPOSES.includes(state.overlay.purpose) ||
      cancelRequestedAt(job.protocol) !== undefined)
  )
    return { configuration: (await abandonCandidate(candidate, "conflict")).application };
  const receipt = await persistAndApplyProspectiveConfiguration(candidate, {
    coordinatorMode: state.overlay.coordinatorMode,
    signal: job.signal,
  });
  return completeRecoveredFollowUp(candidate, receipt.application);
}

/** The follow-ups an ordinary apply leaves to the API: a credential recreate,
 * an integration activation or reload, a staged migration's completion. */
async function completeRecoveredFollowUp(
  candidate: ValidatedConfigurationCandidate,
  application: TrustedConfigurationApplyOutcome,
): Promise<Record<string, unknown>> {
  const state = candidate.state,
    { job } = administrativeConfigurationState(state.writer),
    record = state.record;
  if (!completeTrustedConfigurationApply(application)) return { configuration: application };
  if (!record.maintenanceId && record.apiFollowUp === "service-apply") {
    await completeProspectiveServiceCredential(candidate);
    return { configuration: application };
  }
  if (
    record.apiFollowUp !== "integration-reload" &&
    !record.privateIntegrationReload?.stagedMigration
  )
    return { configuration: application };
  if (
    state.overlay.purpose === "integration-binding" ||
    (state.overlay.purpose === "integration-secret" &&
      state.overlay.changes.some(
        (change) => change.kind === "integration-secret" && change.expectedRevision,
      ))
  ) {
    const applied = await completeIntegrationActivation(candidate, application);
    return {
      configuration: application,
      [state.overlay.purpose === "integration-binding"
        ? "integrationBinding"
        : "integrationApplication"]: applied,
    };
  }
  // An interrupted reload is not permission to run setup again. Only an
  // unattempted reload may begin; a completed one is copied.
  const original = job.checkpointResult?.integrationReload as Record<string, unknown> | undefined;
  if (
    original &&
    (original.state !== "complete" ||
      original.candidateId !== candidate.candidateId ||
      original.revisionId !== candidate.revisionId)
  )
    throw new JobObservationPending("recovery_required");
  if (!original) {
    await job.checkpoint({
      ...job.checkpointResult,
      integrationReload: {
        state: "attempted",
        candidateId: candidate.candidateId,
        revisionId: candidate.revisionId,
      },
    });
    let reloaded: { message: string; reloaded: number; enabled: number };
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
  if (record.privateIntegrationReload?.stagedMigration) {
    migration = migrationCompletionResult({
      operationId: job.jobId,
      steps: (job.checkpointResult?._migrationSteps ?? []) as MigrationResult["steps"],
      pendingServiceIds: z
        .array(id)
        .max(256)
        .optional()
        .parse(job.checkpointResult?._migrationPendingServiceIds),
      application,
    });
    if (migration.outcome === "unknown") throw new JobObservationPending("recovery_required");
    await job.checkpoint({ ...job.checkpointResult, migration });
  }
  await retireSettledProspectiveConfiguration(candidate);
  return { configuration: application, ...(migration ? { migration } : {}) };
}

/** The integration locks a resumed candidate needs, read from its record. */
export async function retainedConfigurationIntegrationIds(
  job: JobContext,
  operationKey: string,
): Promise<string[]> {
  const retained = readAdminJobProtocol(job.protocol).candidate;
  if (!retained || retained.operationKey !== operationKey) return [];
  const found = await findConfigurationCandidate(retained.candidateId);
  if (!found) return [];
  return retainedIntegrationIds(found.record, overlaySchema.parse(found.record.privateOverlay));
}

/** A staged migration preview prepares a candidate only to drop it again. */
export async function discardStagedMigrationPreview(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    owner = administrativeConfigurationState(state.writer);
  if (
    !owner.participant ||
    owner.participant.mode !== "preview" ||
    !isStagedMigrationParticipant(owner.participant, state.writer)
  )
    throw Error("Original staged preview required");
  await discardConfigurationCandidate(state.record.operationKey);
}

/** The candidate's integration sources must still be the ones it captured. */
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
/** Reloads the integration providers with the values the candidate captured. */
export async function reloadProspectiveIntegrations(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    retained = state.record.privateIntegrationReload;
  if (state.phase !== "generation_applied") throw Error("Applied configuration candidate required");
  if (retained?.stagedMigration && retained.integrations.length === 0) {
    await withAdministrativeConfigurationRead({}, async (read) => {
      if (read.integrations.length) throw Error("Integration source changed");
    });
    return { message: "No integration providers", reloaded: 0, enabled: 0 };
  }
  await assertCurrentIntegrationReloadSources(candidate);
  if (!retained?.bindings) throw new JobObservationPending("recovery_required");
  const { reloadIntegrations } = await import("../integration-host");
  return withAdministrativeConfigurationRead({}, async (read) => {
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
/** A non-data-manager credential's recreate, after its ordinary apply. An
 * attempted recreate is only observed again. */
export async function completeProspectiveServiceCredential(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = validatedConfigurationCandidateState(candidate),
    { job: ctx } = administrativeConfigurationState(state.writer),
    operation = state.operation;
  const application = parseTrustedConfigurationApplyOutcome(ctx.checkpointResult?.configuration);
  if (
    state.phase !== "generation_applied" ||
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
    await executeAdminJobOperation(
      ctx,
      { kind: "service.recreate", serviceId, expectedConfigurationRevisionId: revisionId },
      "admin-job.credential.recreate",
      { durableIdentity: serviceId },
    );
    await ctx.checkpoint({
      ...ctx.checkpointResult,
      configuration: application,
      serviceCredential: { serviceId, revisionId, followUp: "complete", hardlinks },
    });
    await retireSettledProspectiveConfiguration(candidate);
  } catch (error) {
    const { OpsObservationPending } = await import("./ops-client");
    const known = error instanceof ApiOpsError || error instanceof AdminJobFailure;
    await ctx.checkpoint({
      ...ctx.checkpointResult,
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
  source?: ConfigurationSourcesInspection,
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
        source?.services
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
  const owner = administrativeConfigurationState(writer),
    retained = protocolCandidate(owner.job);
  // A job's earlier step may have finished its own candidate; an open one blocks the next.
  if (
    retained &&
    retained.operationKey !== input.operationKey &&
    retained.phase !== "generation_applied"
  )
    throw new JobObservationPending("recovery_required");
  const own = retained?.operationKey === input.operationKey ? retained : undefined;
  // Saved rows need no intent: the candidate continues as the agent holds it.
  if (own && own.phase !== "candidate_prepared") {
    const restored = await restoreCandidate(writer, own);
    if (!restored) throw new JobObservationPending("recovery_required");
    return restored;
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
        const reused =
          own &&
          (await reusePreparedCandidate({
            writer,
            retained: own,
            overlay,
            payload,
            fingerprint,
            source,
            rows: merged,
            sourceRows: context,
            integrationReloadSnapshot,
          }));
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
        const candidate = createCandidate({
          writer,
          operationKey: input.operationKey,
          record,
          payload,
          revisionId: sealed.revisionId,
          overlay,
          phase: "candidate_prepared",
          source,
          rows: merged,
          sourceRows: {
            serviceRows: context.serviceRows,
            integrationRows: context.integrationRows,
            serviceSecretRows: context.serviceSecretRows,
            integrationSecretRows: context.integrationSecretRows,
          },
          integrationReloadSnapshot,
        });
        const state = candidate.state;
        await verifyConfigurationCommitParticipant(candidate);
        assertRowReceiptBudget(
          savedRowIntents(state).map((row) => ({
            ...row,
            rowVersion: row.state === "present" ? "4294967295" : null,
          })),
        );
        await retainConfigurationCandidate(record);
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
          assertMaintenanceIntentCapacity(state, owner.job.protocol);
        } catch (error) {
          if (coordinator?.action === "update")
            await closeUnissuedCoordinatorPull(owner.job, candidateId, record.operationKey);
          // The preview is read-only and nothing was admitted for this candidate.
          await discardConfigurationCandidate(record.operationKey);
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
  // A migration preview prepares a candidate only to drop it again.
  if (owner.participant?.mode !== "preview" && result.candidateId !== own?.candidateId)
    owner.job.protocol = await writeAdminJobCandidate(
      owner.connection,
      owner.job.jobId,
      owner.job.execution,
      candidateProtocol(result, "candidate_prepared"),
    );
  return result;
}

/** One verification at preparation: the participant still holds its intent and
 * the overlay is the one it authorized. The save's transaction checks the rest. */
async function verifyConfigurationCommitParticipant(
  candidate: ValidatedConfigurationCandidate,
): Promise<void> {
  const state = candidate.state,
    writer = state.writer,
    owner = administrativeConfigurationState(writer);
  if (state.record.privateCoordinatorLifecycle) {
    const [actual] = await owner.connection
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(owner.job.jobId, owner.job.execution));
    if (!actual) throw Error("Actual coordinator job unavailable");
    assertRetainedCoordinatorLifecycleProvenance(actual, state.record);
  }
  if (state.overlay.purpose === "migration") {
    if (!owner.participant || !isStagedMigrationParticipant(owner.participant, writer))
      throw Error("Configuration commit participant unavailable");
    assertStagedMigrationOverlay(writer, state.overlay);
  }
  if (state.overlay.purpose === "integration-binding")
    assertIntegrationBindingOverlay(writer, state.overlay);
  if (state.overlay.purpose === "platform") {
    assertPlatformConfigurationOverlay(writer, state.overlay);
    const intent = retainedPlatformConfigurationIntent(writer);
    if (
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

/** A rerun of a job step before its rows were saved continues with the
 * candidate it prepared, keeping its identifiers and operation keys, when the
 * rows still build the same payload. Otherwise the candidate is stale and the
 * save is not attempted. Undefined when the agent no longer holds it. */
async function reusePreparedCandidate(input: {
  writer: AdministrativeConfigurationWriter;
  retained: AdminJobCandidate;
  overlay: Overlay;
  payload: TrustedConfigurationPayload;
  fingerprint: string;
  source: ConfigurationSourcesInspection;
  rows: NonNullable<CandidateState["rows"]>;
  sourceRows: NonNullable<CandidateState["sourceRows"]>;
  integrationReloadSnapshot: CandidateState["integrationReloadSnapshot"];
}): Promise<ValidatedConfigurationCandidate | undefined> {
  const candidate = await restoreCandidate(input.writer, input.retained);
  if (!candidate) return undefined;
  const state = candidate.state;
  state.source = input.source;
  state.rows = input.rows;
  state.sourceRows = {
    serviceRows: input.sourceRows.serviceRows,
    integrationRows: input.sourceRows.integrationRows,
    serviceSecretRows: input.sourceRows.serviceSecretRows,
    integrationSecretRows: input.sourceRows.integrationSecretRows,
  };
  state.integrationReloadSnapshot = input.integrationReloadSnapshot;
  state.stale =
    state.record.sourceFingerprint !== input.fingerprint ||
    state.record.expectedSourceRevision !== input.source.sourceRevision ||
    canonicalJson(state.record.privateOverlay) !== canonicalJson(input.overlay) ||
    canonicalJson(state.payload) !== canonicalJson(input.payload);
  if (!state.stale) await verifyConfigurationCommitParticipant(candidate);
  return candidate;
}

/** Local count arithmetic only. No future decision body/root is allocated.
 * All exact known middle-owner addresses plus the two original controls must
 * fit the existing shared64 map before helper/pull; later CAS still rechecks. */
function assertMaintenanceIntentCapacity(state: CandidateState, protocol: unknown): void {
  const record = state.record;
  if (!record.maintenanceId || !record.prepareOperationKey) return;
  const projection = readProjection(protocol),
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

/** Reads the coordinator's state as the candidate's hardlinks preview reports it. */
async function coordinatorState(candidate: ValidatedConfigurationCandidate, state: CandidateState) {
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
    { signal: administrativeConfigurationState(state.writer).job.signal },
  );
  return preview.coordinatorState;
}

/** The old-revision coordinator a maintenance needs is started outside the
 * maintenance, before its preparation. A coordinator update observes the old
 * coordinator it already found running and never starts it after the pull. */
async function prepareMaintenanceCoordinator(
  candidate: ValidatedConfigurationCandidate,
  state: CandidateState,
): Promise<void> {
  if (
    !state.record.maintenanceId ||
    (!state.preview?.entries && !state.record.privateCoordinatorLifecycle) ||
    state.overlay.coordinatorMode !== "ensure-running"
  )
    return;
  const { job } = administrativeConfigurationState(state.writer),
    fixed = state.record.coordinatorPrerequisite;
  if (
    !fixed ||
    !candidate.expectedCurrentRevisionId ||
    fixed.operation.expectedConfigurationRevisionId !== candidate.expectedCurrentRevisionId
  )
    throw Error("Configuration coordinator prerequisite unavailable");
  job.signal.throwIfAborted();
  if (Date.parse(state.record.snapshot.expiresAt) <= Date.now())
    throw new CandidateRefused("Configuration candidate expired");
  const lifecycle = state.record.privateCoordinatorLifecycle,
    projection = readProjection(job.protocol),
    beforePull =
      lifecycle?.action === "update"
        ? projection.operations[lifecycle.pull.operationKey]
        : undefined;
  if (lifecycle && beforePull && beforePull.phase !== "prepared") {
    if (projection.operations[fixed.root.operationKey])
      await executeAdminJobOperation(
        job,
        fixed.operation,
        "configuration-maintenance.coordinator",
        {
          operationKey: fixed.stepAddress,
          preparedRoot: fixed.root,
        },
      );
    if ((await coordinatorState(candidate, state)) !== "running")
      throw new JobObservationPending("recovery_required");
    return;
  }
  if (lifecycle && state.preview?.coordinatorState === "running") return;
  if (beforePull && beforePull.phase !== "prepared")
    throw new JobObservationPending("recovery_required");
  await executeAdminJobOperation(job, fixed.operation, "configuration-maintenance.coordinator", {
    operationKey: fixed.stepAddress,
    preparedRoot: fixed.root,
  });
  job.signal.throwIfAborted();
  if ((await coordinatorState(candidate, state)) !== "running")
    throw new CandidateRefused("Configuration coordinator prerequisite unavailable");
}

const parentSchema = z.strictObject({
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: z.number().int().nonnegative().safe(),
});
/** A maintenance settle has its own short deadline, so it can still be sent
 * once the job's parent deadline passed or the job was cancelled. */
function maintenanceSettleRoot(job: JobContext, stepAddress: string) {
  const parent = parentSchema.parse(job.checkpointResult?._parentExecution);
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
/** The record the agent answered is this job's maintenance. */
function ownRecord(job: JobContext, record: MaintenanceRecord, maintenanceId: string) {
  if (record.maintenanceId !== maintenanceId || record.apiJobId !== job.jobId)
    throw Error("Configuration maintenance identity changed");
  return record;
}

/** Asks the agent to prepare the candidate's maintenance (acquire the targets,
 * prepare data-manager's fence). Keyed by the job and the candidate: a repeat
 * returns the original preparation. */
async function prepareConfigurationMaintenance(
  candidate: ValidatedConfigurationCandidate,
): Promise<MaintenanceRecord> {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    record = state.record,
    apply = state.operation;
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
    coordinatorMode: state.overlay.coordinatorMode,
    followUp: record.privatePlatformIntent
      ? "platform-apply"
      : record.apiFollowUp === "service-apply" ||
          record.privateCoordinatorLifecycle ||
          record.privateIntegrationReload?.stagedMigration
        ? "service-apply"
        : "render-only",
  });
  const prepared = ownRecord(
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
    record.maintenanceId,
  );
  if (prepared.state !== "prepared" || prepared.fence?.state !== "prepared")
    throw Error("Original prepared maintenance record required");
  return prepared;
}

/** A read of the maintenance record; it never changes anything at the agent
 * other than recording a helper that exited. */
async function inspectConfigurationMaintenance(maintenanceId: string): Promise<MaintenanceRecord> {
  const { job } = administrativeConfigurationState(currentAdministrativeConfigurationWriter());
  if (!job.execution) throw Error("Original retained maintenance inspection required");
  const parent = parentSchema.parse(job.checkpointResult?._parentExecution),
    operation = { kind: "configurationMaintenance.inspect" as const, maintenanceId },
    key = createDurableOpsKey(
      "configuration-maintenance.inspect",
      `${job.jobId}:${maintenanceId}:${randomUUID()}`,
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
  return ownRecord(job, maintenanceRecordSchema.parse(response.value), maintenanceId);
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
  const retained = readAdminJobProtocol(job.protocol).candidate;
  if (retained?.phase !== "rows_saved" || !retained.maintenanceId) return;
  const applied = Object.values(readProjection(job.protocol).operations).some(
    (operation) =>
      operation.kind === "configurationMaintenance.apply" &&
      operation.terminal &&
      (operation.result as { outcome?: unknown } | undefined)?.outcome === "running",
  );
  if (applied) await settleJobMaintenance(job, retained.maintenanceId, "abandon");
}

async function settleJobMaintenance(
  job: JobContext,
  maintenanceId: string,
  outcome: "complete" | "abandon",
): Promise<MaintenanceRecord> {
  const stepAddress = createDurableOpsKey(
      "configuration-maintenance.settle",
      `${job.jobId}:${maintenanceId}:${outcome}`,
    ),
    retainedRoot = readProjection(job.protocol).steps[stepAddress],
    root = retainedRoot ? undefined : maintenanceSettleRoot(job, stepAddress);
  return ownRecord(
    job,
    maintenanceRecordSchema.parse(
      await executeAdminJobOperation(
        job,
        { kind: "configurationMaintenance.settle", maintenanceId, outcome },
        "configuration-maintenance.settle",
        { operationKey: stepAddress, ...(root ? { preparedRoot: root } : {}) },
      ),
    ),
    maintenanceId,
  );
}

/** Applies a saved maintenance candidate: every step at the agent, then, once
 * the handoff (if any) ended, the settlement. A cancel stops the maintenance
 * after the step in flight; the job then ends without success. */
async function applySavedConfigurationMaintenance(candidate: ValidatedConfigurationCandidate) {
  const state = validatedConfigurationCandidateState(candidate),
    { job } = administrativeConfigurationState(state.writer),
    maintenanceId = state.record.maintenanceId!;
  const cancelled = () => cancelRequestedAt(job.protocol) !== undefined;
  // A cancelled job starts no apply, but observes the one it already sent: its
  // result carries the generation the agent committed.
  const attempted = Object.values(readProjection(job.protocol).operations).some(
    (operation) => operation.kind === "configurationMaintenance.apply",
  );
  let applied: OpsResultFor<"configurationMaintenance.apply"> | undefined;
  if (!cancelled() || attempted)
    applied = await executeAdminJobOperation(
      job,
      { kind: "configurationMaintenance.apply", maintenanceId },
      "configuration-maintenance.apply",
      { durableIdentity: maintenanceId },
    );
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

/** A coordinator update that stopped after reserving its pull but before its
 * candidate was recorded never sent the pull: the slot is closed, an orphaned
 * candidate dropped, and the job ends without the update. */
export async function reconcileUnstagedCoordinatorPull(): Promise<void> {
  const writer = currentAdministrativeConfigurationWriter(),
    { job } = administrativeConfigurationState(writer);
  if (job.jobType !== "service.bulk" || protocolCandidate(job)) return;
  const { parseServiceUpdateBatch } = await import("./service-update-batch"),
    batch = parseServiceUpdateBatch(job.payload, job.checkpointResult),
    ordinal = batch.serviceIds.indexOf("data-manager"),
    projection = readProjection(job.protocol),
    address = createDurableOpsKey("configuration.coordinator-pull", `${job.jobId}:${ordinal}`),
    entry = projection.operations[projection.steps[address]?.operationKey ?? address];
  if (!entry) return;
  const operation = entry.operation;
  if (entry.phase !== "prepared" || operation?.kind !== "service.pull" || !operation.candidateId)
    throw new JobObservationPending("recovery_required");
  const orphan = await findConfigurationCandidate(operation.candidateId);
  await closeUnissuedCoordinatorPull(job, operation.candidateId, orphan?.record.operationKey);
  if (orphan) await discardConfigurationCandidate(orphan.record.operationKey);
  throw new AdminJobFailure("Original configuration candidate was not issued", {
    configuration: notCommitted("conflict"),
  });
}
