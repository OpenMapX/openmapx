/** Durable ordering for the existing queued Update producer. These records are
 * correlation data; every completed stage still reads its original agent ACK. */
import { canonicalJson } from "@openmapx/core/ops";
import { z } from "zod";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import { jobCheckpoint, jobOwnership, replaceJobCheckpoint } from "./admin-job-state";
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
    const result = jobCheckpoint(row.result, row.protocol) ?? {};
    if (result._serviceUpdateBatch) {
      retained = result;
      return parseServiceUpdateBatch(row.payload, result);
    }
    retained = { ...result, _serviceUpdateBatch: original };
    const rows = await tx
      .update(adminJob)
      .set(replaceJobCheckpoint(retained))
      .where(jobOwnership(ctx.jobId, ctx.execution))
      .returning({ id: adminJob.id });
    if (rows.length !== 1) throw new JobObservationPending("recovery_required");
    return original;
  });
  ctx.checkpointResult = retained;
  return batch;
}
