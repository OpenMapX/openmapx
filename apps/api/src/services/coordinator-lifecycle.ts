/** Sole nominal issuer for the existing queued DM Apply / Update producers.
 * It derives provenance from the retained owned job; no target, callback,
 * participant, result, authority flag or prepared attempt can be supplied. */
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  coordinatorLifecycleMetadataSchema,
  type PreparedConfigurationRecord,
  readOpsTokenFile,
} from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { readProjection } from "./admin-job-projection";
import { jobOwnership } from "./admin-job-state";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
} from "./administrative-configuration-writer-owner";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import {
  configurationPublisherFromEnvironment,
  readPreparedTrustedConfigurationCandidate,
} from "./trusted-config-publication-store";

declare const coordinatorIntent: unique symbol;
export interface CoordinatorLifecycleIntent {
  readonly [coordinatorIntent]: true;
}
type State = {
  writer: AdministrativeConfigurationWriter;
  job: JobContext;
  provenance: string;
  candidateId: string;
  action: "apply" | "update";
  originalOrdinal: number | null;
  noDeps: boolean;
};
const intents = new WeakMap<CoordinatorLifecycleIntent, State>();
const refuse = () => Error("Original coordinator lifecycle job required");
export function coordinatorLifecycleOperationKey(jobId: string, ordinal: number | null) {
  return createDurableOpsKey(
    "configuration.coordinator-lifecycle",
    `${jobId}:${ordinal ?? "apply"}`,
  );
}
function provenance(row: typeof adminJob.$inferSelect) {
  return canonicalJson({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdBy: row.createdBy,
  });
}
export async function prepareCoordinatorLifecycleIntent(
  writer: AdministrativeConfigurationWriter,
  originalOrdinal: number | null,
): Promise<CoordinatorLifecycleIntent> {
  const { job, participant, transactionActive } = administrativeConfigurationState(writer);
  if (
    !job.execution ||
    participant ||
    transactionActive ||
    job.observationOnly ||
    writer.actorId !== job.jobId ||
    writer.operationKey !== coordinatorLifecycleOperationKey(job.jobId, originalOrdinal) ||
    writer.integrationIds.length
  )
    throw refuse();
  const [row] = await db.select().from(adminJob).where(jobOwnership(job.jobId, job.execution));
  if (!row || row.type !== job.jobType || canonicalJson(row.payload) !== canonicalJson(job.payload))
    throw refuse();
  const payload = row.payload as Record<string, unknown>;
  let action: "apply" | "update",
    noDeps = false;
  if (originalOrdinal === null) {
    if (
      row.type !== "service.apply" ||
      payload.service !== "data-manager" ||
      Object.keys(payload).some((k) => k !== "service")
    )
      throw refuse();
    action = "apply";
  } else {
    if (
      !Number.isInteger(originalOrdinal) ||
      originalOrdinal < 0 ||
      originalOrdinal > 255 ||
      row.type !== "service.bulk" ||
      payload.action !== "update" ||
      !Array.isArray(payload.serviceIds) ||
      payload.serviceIds[originalOrdinal] !== "data-manager" ||
      payload.serviceIds.filter((id) => id === "data-manager").length !== 1 ||
      (payload.noDeps !== undefined && typeof payload.noDeps !== "boolean") ||
      Object.keys(payload).some(
        (k) => !["action", "serviceIds", "all", "region", "continueOnError", "noDeps"].includes(k),
      )
    )
      throw refuse();
    action = "update";
    noDeps = payload.noDeps === true;
  }
  const intent = Object.freeze({}) as CoordinatorLifecycleIntent;
  intents.set(intent, {
    writer,
    job,
    provenance: provenance(row),
    candidateId: randomUUID(),
    action,
    originalOrdinal,
    noDeps,
  });
  return intent;
}
export async function assertCoordinatorLifecycleIntent(
  intent: CoordinatorLifecycleIntent,
  writer: AdministrativeConfigurationWriter,
) {
  const state = intents.get(intent),
    owner = administrativeConfigurationState(writer);
  if (
    !state ||
    state.writer !== writer ||
    state.job !== owner.job ||
    owner.participant ||
    (owner.transactionActive && owner.transactionMode !== "read")
  )
    throw refuse();
  const [row] = await db
    .select()
    .from(adminJob)
    .where(jobOwnership(state.job.jobId, state.job.execution));
  if (!row || state.provenance !== provenance(row)) throw refuse();
  return state;
}
export async function assertCoordinatorPullIntent(
  intent: CoordinatorLifecycleIntent,
  context: JobContext,
) {
  const state = intents.get(intent);
  if (!state || state.job !== context || state.action !== "update") throw refuse();
  return assertCoordinatorLifecycleIntent(intent, state.writer);
}

/** Historical MAC provenance recheck against the actual current owned row.
 * This does not mint a fresh intent, candidate or attempt. */
export function assertRetainedCoordinatorLifecycleProvenance(
  row: typeof adminJob.$inferSelect,
  record: PreparedConfigurationRecord,
) {
  const fixed = coordinatorLifecycleMetadataSchema.parse(record.privateCoordinatorLifecycle),
    payload = row.payload as Record<string, unknown>;
  if (
    row.id !== record.apiJobId ||
    record.actorId !== row.id ||
    record.apiFollowUp !== `coordinator-${fixed.action}` ||
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    canonicalJson(record.affectedServiceIds) !== '["data-manager"]' ||
    canonicalJson(record.privateOverlay) !==
      canonicalJson({ purpose: "render", coordinatorMode: "ensure-running", changes: [] }) ||
    (fixed.action === "apply"
      ? row.type !== "service.apply" ||
        payload.service !== "data-manager" ||
        Object.keys(payload).some((k) => k !== "service")
      : row.type !== "service.bulk" ||
        payload.action !== "update" ||
        !Array.isArray(payload.serviceIds) ||
        payload.serviceIds[fixed.originalOrdinal] !== "data-manager" ||
        payload.serviceIds.filter((id) => id === "data-manager").length !== 1 ||
        fixed.noDeps !== (payload.noDeps === true) ||
        fixed.pull.operation.candidateId !== record.candidateId ||
        fixed.pull.attempt.apiJobId !== row.id ||
        fixed.pull.attempt.parentOperationKey !== record.parentOperationKey ||
        fixed.pull.attempt.parentFingerprint !== record.parentFingerprint ||
        fixed.pull.attempt.parentDeadlineAt !== record.parentDeadlineAt)
  )
    throw refuse();
  return fixed;
}

/** The one first-delivery CAS. Generic managed checkpoints cannot change a
 * prepared pull into an attempted one. Old-owner attempt bytes are preserved. */
export async function claimCoordinatorPullDelivery(context: JobContext, candidateId: string) {
  if (!context.execution || context.observationOnly) throw refuse();
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
  let updated: Record<string, unknown> | undefined;
  const delivery = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(context.jobId, context.execution))
      .for("update");
    if (!row) throw refuse();
    const result = row.result as Record<string, unknown>,
      checkpoint = result?._configurationCandidate as Record<string, unknown>;
    if (
      !checkpoint ||
      checkpoint.candidateId !== candidateId ||
      typeof checkpoint.sealedOperationKey !== "string" ||
      checkpoint.operationKey !==
        coordinatorLifecycleOperationKey(
          context.jobId,
          (row.payload as { serviceIds?: string[] })?.serviceIds?.indexOf("data-manager") ?? null,
        )
    )
      throw refuse();
    const retained = await readPreparedTrustedConfigurationCandidate(
        configurationPublisherFromEnvironment(token),
        checkpoint.sealedOperationKey,
      ),
      record = retained.record,
      fixed = assertRetainedCoordinatorLifecycleProvenance(row, record);
    if (
      fixed.action !== "update" ||
      record.candidateId !== candidateId ||
      checkpoint.phase !== "prepared" ||
      result._configurationMaintenance !== undefined
    )
      throw refuse();
    const pull = fixed.pull,
      projection = readProjection(result),
      entry = projection.operations[pull.operationKey];
    if (
      !entry ||
      projection.steps[pull.stepAddress]?.operationKey !== pull.operationKey ||
      canonicalJson(entry.operation) !== canonicalJson(pull.operation) ||
      canonicalJson(entry.attempt) !== canonicalJson(pull.attempt)
    )
      throw refuse();
    if (entry.phase === "unissued") throw refuse();
    if (entry.phase !== "prepared") {
      updated = result;
      return { operationKey: pull.operationKey, fresh: false };
    }
    if (
      result._cancelRequestedAt !== undefined ||
      Date.now() >= pull.requestedDeadlineAt ||
      Date.now() >= record.parentDeadlineAt ||
      retained.snapshot.expiresAtMs <= Date.now()
    )
      throw refuse();
    projection.operations[pull.operationKey] = { ...entry, phase: "admitting" };
    updated = { ...result, opsProjection: projection };
    const saved = await tx
      .update(adminJob)
      .set({ result: updated })
      .where(jobOwnership(context.jobId, context.execution))
      .returning({ id: adminJob.id });
    if (saved.length !== 1) throw refuse();
    return { operationKey: pull.operationKey, fresh: true };
  });
  if (!updated) throw refuse();
  context.checkpointResult = updated;
  return delivery;
}

/** Local nonissuance is derived from the actual locked PREPARED slot. First
 * delivery MUST atomically leave that phase before any HTTP POST; generic
 * checkpoints cannot restore it. This is no agent refusal or terminal copy. */
export async function closeUnissuedCoordinatorPull(
  context: JobContext,
  candidateId: string,
  packetOperationKey?: string,
): Promise<void> {
  if (!context.execution || context.observationOnly) throw refuse();
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(context.jobId, context.execution))
      .for("update");
    if (!row || row.type !== "service.bulk") throw refuse();
    const payload = row.payload as { action?: string; serviceIds?: string[] },
      ordinal = payload.serviceIds?.indexOf("data-manager") ?? -1;
    if (
      payload.action !== "update" ||
      ordinal < 0 ||
      payload.serviceIds?.filter((id) => id === "data-manager").length !== 1
    )
      throw refuse();
    const result = (row.result ?? {}) as Record<string, unknown>,
      projection = readProjection(result),
      stepAddress = createDurableOpsKey(
        "configuration.coordinator-pull",
        `${context.jobId}:${ordinal}`,
      ),
      key = projection.steps[stepAddress]?.operationKey,
      entry = key ? projection.operations[key] : undefined;
    if (!entry) return result;
    if (
      entry.operation?.kind !== "service.pull" ||
      entry.operation.serviceId !== "data-manager" ||
      entry.operation.candidateId !== candidateId ||
      !entry.attempt ||
      entry.attempt.apiJobId !== row.id ||
      entry.attempt.apiOwnerVersion > context.execution!.version ||
      canonicalJson({
        operationKey: entry.attempt.parentOperationKey,
        fingerprint: entry.attempt.parentFingerprint,
        deadlineAt: entry.attempt.parentDeadlineAt,
      }) !== canonicalJson(result._parentExecution)
    )
      throw refuse();
    if (entry.phase !== "prepared") return result;
    if (
      result._configurationMaintenance !== undefined ||
      result._configurationMaintenanceDecision !== undefined ||
      result._configurationMaintenanceRollback !== undefined
    )
      throw refuse();
    try {
      const checkpoint = result._configurationCandidate as
        | { sealedOperationKey?: string }
        | undefined;
      const originalPacket = checkpoint?.sealedOperationKey ?? packetOperationKey;
      if (!originalPacket) {
        // This caller failed before constructing any private packet. A first
        // delivery still required both that packet and the staged checkpoint.
      } else {
        const source = await readPreparedTrustedConfigurationCandidate(
            configurationPublisherFromEnvironment(token),
            originalPacket,
          ),
          fixed = assertRetainedCoordinatorLifecycleProvenance(row, source.record);
        if (
          fixed.action !== "update" ||
          source.record.candidateId !== candidateId ||
          canonicalJson(fixed.pull.operation) !== canonicalJson(entry.operation) ||
          canonicalJson(fixed.pull.attempt) !== canonicalJson(entry.attempt)
        )
          throw refuse();
      }
    } catch (error) {
      // Missing private bytes cannot have been delivered from a PREPARED slot:
      // the fixed first-delivery CAS also requires this MAC candidate/checkpoint.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    projection.operations[key!] = {
      ...entry,
      phase: "unissued",
      terminal: true,
      nonissuance: {
        version: 1,
        candidateId,
        checkedOwnerVersion: context.execution!.version,
        checkedAt: Date.now(),
      },
    };
    const next = { ...result, opsProjection: projection };
    const saved = await tx
      .update(adminJob)
      .set({ result: next })
      .where(jobOwnership(context.jobId, context.execution))
      .returning({ id: adminJob.id });
    if (saved.length !== 1) throw refuse();
    return next;
  });
  context.checkpointResult = updated;
}
