import { type ServiceBatchResult, serviceBatchResultSchema } from "@openmapx/core/ops";
import { AdminJobFailure } from "./admin-job-failure";
import type { JobContext } from "./job-runner";

export async function checkpointServiceBatch(
  ctx: JobContext,
  result: ServiceBatchResult,
): Promise<ServiceBatchResult> {
  const serviceBatch = serviceBatchResultSchema.parse(result);
  await ctx.checkpoint({ ...ctx.checkpointResult, serviceBatch });
  return serviceBatch;
}

export async function finishServiceBatch(
  ctx: JobContext,
  result: ServiceBatchResult,
): Promise<ServiceBatchResult> {
  const serviceBatch = await checkpointServiceBatch(ctx, result);
  if (serviceBatch.outcome !== "success")
    throw new AdminJobFailure("Service batch failed", { ...ctx.checkpointResult, serviceBatch });
  return serviceBatch;
}
