/** Durable ordering for the existing queued Update producer. These records are
 * correlation data; every completed stage still reads its original agent ACK. */
import { canonicalJson } from "@openmapx/core/ops";
import { z } from "zod";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import { jobOwnership } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const serviceUpdateBatchSchema = z.strictObject({
  version: z.literal(1),
  serviceIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .min(1)
    .max(256),
  noDeps: z.boolean(),
  initialRevisionId: revision,
});
export function parseServiceUpdateBatch(payload: unknown, result: unknown) {
  const original = payload as { action?: unknown; serviceIds?: unknown; noDeps?: unknown };
  const batch = serviceUpdateBatchSchema.parse(
    (result as Record<string, unknown> | null)?._serviceUpdateBatch,
  );
  if (
    original.action !== "update" ||
    canonicalJson(original.serviceIds) !== canonicalJson(batch.serviceIds) ||
    batch.noDeps !== (original.noDeps === true) ||
    new Set(batch.serviceIds).size !== batch.serviceIds.length
  )
    throw new JobObservationPending("invalid_identity");
  return batch;
}
export async function prepareServiceUpdateBatch(ctx: JobContext) {
  if (!ctx.execution || ctx.observationOnly || ctx.jobType !== "service.bulk")
    throw new JobObservationPending("recovery_required");
  if (ctx.checkpointResult?._serviceUpdateBatch)
    return parseServiceUpdateBatch(ctx.payload, ctx.checkpointResult);
  const observed = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.inspect" },
    createDurableOpsKey("admin-job.bulk-update-current", ctx.jobId),
    { signal: ctx.signal },
  );
  const original = serviceUpdateBatchSchema.parse({
    version: 1,
    serviceIds: ctx.payload.serviceIds,
    noDeps: ctx.payload.noDeps === true,
    initialRevisionId: observed.revisionId,
  });
  let retained: Record<string, unknown> | undefined;
  const batch = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(ctx.jobId, ctx.execution))
      .for("update");
    if (
      !row ||
      row.type !== ctx.jobType ||
      canonicalJson(row.payload) !== canonicalJson(ctx.payload)
    )
      throw new JobObservationPending("invalid_identity");
    const result = (row.result ?? {}) as Record<string, unknown>;
    if (result._serviceUpdateBatch) {
      retained = result;
      return parseServiceUpdateBatch(row.payload, result);
    }
    // An older partially attempted batch has no trustworthy original revision.
    // Never infer that input from the current pointer on recovery.
    if (result.opsProjection || result._configurationCandidate)
      throw new JobObservationPending("recovery_required");
    retained = { ...result, _serviceUpdateBatch: original };
    const rows = await tx
      .update(adminJob)
      .set({ result: retained })
      .where(jobOwnership(ctx.jobId, ctx.execution))
      .returning({ id: adminJob.id });
    if (rows.length !== 1) throw new JobObservationPending("recovery_required");
    return original;
  });
  ctx.checkpointResult = retained;
  return batch;
}

/** Hand off only a completed configuration stage in THIS fixed batch. No
 * operation/attempt/ACK is removed, and the single DM graph stays observable. */
export async function advanceCompletedBulkCandidate(
  writer: import("./administrative-configuration-writer-owner").AdministrativeConfigurationWriter,
) {
  const { administrativeConfigurationState, withConfigurationWriteTransaction } = await import(
    "./administrative-configuration-writer-owner"
  );
  const { completedCoordinatorMaintenance } = await import(
    "./configuration-maintenance-step-records"
  );
  const { hasPendingReceiptDelivery, hasUnsettledManagedOperation } = await import(
    "./admin-job-state"
  );
  const { completeTrustedConfigurationApply, parseTrustedConfigurationApplyOutcome } = await import(
    "./trusted-config-outcome"
  );
  const { coordinatorLifecycleOperationKey } = await import("./coordinator-lifecycle");
  const { job } = administrativeConfigurationState(writer);
  let committed: Record<string, unknown> | undefined;
  await withConfigurationWriteTransaction(writer, async (tx) => {
    const [row] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(job.jobId, job.execution))
      .for("update");
    if (
      !row ||
      row.type !== "service.bulk" ||
      canonicalJson(row.payload) !== canonicalJson(job.payload)
    )
      throw new JobObservationPending("invalid_identity");
    const result = (row.result ?? {}) as Record<string, unknown>,
      batch = parseServiceUpdateBatch(row.payload, result),
      previous = result._configurationCandidate as Record<string, unknown> | undefined;
    if (!previous || previous.operationKey === writer.operationKey) return;
    const ordinal = batch.serviceIds.indexOf("data-manager"),
      seedKey = createDurableOpsKey("admin-job.config.prepare", `${job.jobId}:bulk-update`),
      coordinatorKey = coordinatorLifecycleOperationKey(job.jobId, ordinal);
    if (
      ordinal < 0 ||
      !(
        (previous.operationKey === seedKey && writer.operationKey === coordinatorKey) ||
        (previous.operationKey === coordinatorKey && writer.operationKey === seedKey)
      ) ||
      previous.phase !== "settled" ||
      hasPendingReceiptDelivery(result) ||
      hasUnsettledManagedOperation(result)
    )
      throw new JobObservationPending("recovery_required");
    const outcome = parseTrustedConfigurationApplyOutcome(
      (result._configurationOutcomes as Record<string, unknown>)?.[String(previous.operationKey)],
    );
    if (
      !completeTrustedConfigurationApply(outcome) ||
      outcome.outcome !== "committed" ||
      outcome.revisionId !== previous.revisionId
    )
      throw new JobObservationPending("recovery_required");
    if (previous.maintenanceId) {
      const archived = completedCoordinatorMaintenance(result);
      if (
        archived.receipt.apiJobId !== job.jobId ||
        archived.originalOrdinal !== ordinal ||
        archived.candidate.candidateId !== previous.candidateId
      )
        throw new JobObservationPending("recovery_required");
    } else if (result._configurationMaintenance)
      throw new JobObservationPending("recovery_required");
    committed = { ...result };
    for (const field of [
      "_configurationCandidate",
      "_configurationMaintenance",
      "_configurationMaintenanceDecision",
      "_configurationMaintenanceSteps",
      "_configurationMaintenanceSettle",
      "_configurationMaintenanceRollback",
      "_configurationCoordinatorPrerequisite",
      "_completion",
    ])
      delete committed[field];
    const saved = await tx
      .update(adminJob)
      .set({ result: committed })
      .where(jobOwnership(job.jobId, job.execution))
      .returning({ id: adminJob.id });
    if (saved.length !== 1) throw new JobObservationPending("recovery_required");
  });
  if (committed) job.checkpointResult = committed;
}

/** Validate the exact successful prefix before the unique DM ordinal. No
 * completed flag/current pointer can replace these original body/result/ACKs. */
export async function completedServiceUpdatePrefix(
  jobId: string,
  payload: unknown,
  result: Record<string, unknown>,
  ordinal: number,
) {
  const batch = parseServiceUpdateBatch(payload, result),
    { readProjection } = await import("./admin-job-projection"),
    projection = readProjection(result),
    { configurationApplyResultSchema, parseOpsResult } = await import("@openmapx/core/ops"),
    keys = new Set<string>();
  if (
    batch.serviceIds[ordinal] !== "data-manager" ||
    batch.serviceIds.indexOf("data-manager") !== ordinal
  )
    throw new JobObservationPending("invalid_identity");
  let working = batch.initialRevisionId,
    seed = false;
  const original = (address: string) => {
    const entry = projection.operations[projection.steps[address]?.operationKey ?? address];
    if (
      !entry?.terminal ||
      entry.phase !== "terminal" ||
      entry.errorClass ||
      entry.attempt?.apiJobId !== jobId ||
      entry.receiptDelivery?.state !== "confirmed" ||
      entry.receiptDelivery.terminalReceipt.state !== "succeeded"
    )
      throw new JobObservationPending("recovery_required");
    keys.add(entry.operationKey);
    return entry;
  };
  for (const serviceId of batch.serviceIds.slice(0, ordinal)) {
    if (!seed) {
      const address = createDurableOpsKey("admin-job.config.prepare", `${jobId}:bulk-update`),
        entry = original(address),
        outcome = configurationApplyResultSchema.parse(entry.result);
      if (
        entry.operation?.kind !== "stack.render" ||
        entry.operation.expectedCurrentRevisionId !== working ||
        outcome.outcome !== "committed" ||
        outcome.followUp !== "complete" ||
        outcome.cleanupFailed ||
        (result._configurationOutcomes as Record<string, unknown>)?.[address] === undefined
      )
        throw new JobObservationPending("invalid_identity");
      working = outcome.revisionId;
      seed = true;
    }
    const entry = original(
      createDurableOpsKey("admin-job.service.update", `${jobId}:${serviceId}`),
    );
    if (
      entry.operation?.kind !== "service.update" ||
      entry.operation.serviceId !== serviceId ||
      entry.operation.expectedConfigurationRevisionId !== working ||
      (entry.operation.noDeps ?? false) !== batch.noDeps
    )
      throw new JobObservationPending("invalid_identity");
    working = parseOpsResult("service.update", entry.result).revisionId;
  }
  return { operationKeys: keys, revisionId: working };
}
