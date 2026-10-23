import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type OpsOperation,
  opsExecutionBudget,
  opsOperationFingerprint,
  readOpsTokenFile,
} from "@openmapx/core/ops";
import { z } from "zod";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";

export const apiJobChildAttemptSchema = z.strictObject({
  version: z.literal(1),
  apiJobId: z.uuid(),
  apiOwnerVersion: z.number().int().positive().safe(),
  parentOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  parentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  parentDeadlineAt: z.number().int().nonnegative().safe(),
  childOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  childOperationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestedDeadlineAt: z.number().int().nonnegative().safe(),
  attemptId: z.uuid(),
});
export type ApiJobChildAttempt = z.infer<typeof apiJobChildAttemptSchema>;

function parentJobBudget(ctx: JobContext, operation: OpsOperation): number {
  if (ctx.jobType === "system.update") return opsExecutionBudget("system.update").processMs;
  if (ctx.jobType === "service.start" || ctx.jobType === "service.apply") {
    // Fixed current workflow: render, inspect, start the coordinator, await its
    // one-minute readiness window, apply hardlinks, then start/recreate service.
    return [
      "stack.render",
      "configuration.hardlinks.inspect",
      "service.start",
      "generation-hardlinks",
      ctx.jobType === "service.apply" ? "service.recreate" : "service.start",
    ].reduce((sum, kind) => sum + opsExecutionBudget(kind).processMs, 60_000);
  }
  if (ctx.jobType === "service.bulk") return opsExecutionBudget("services.buildAll").processMs;
  return opsExecutionBudget(operation.kind).processMs;
}
/** These non-secret fields are checkpointed before the assertion is minted. */
export function prepareApiJobChildAttempt(
  ctx: JobContext,
  operation: OpsOperation,
  key: string,
): ApiJobChildAttempt | undefined {
  if (!ctx.execution) return undefined;
  const retained = ctx.checkpointResult?._parentExecution as
    | { operationKey: string; fingerprint: string; deadlineAt: number }
    | undefined;
  const parent = retained ?? {
    operationKey: createDurableOpsKey("admin-job.parent", ctx.jobId),
    // Job identity, not its potentially secret payload, binds the parent.
    fingerprint: createHash("sha256")
      .update(canonicalJson({ jobId: ctx.jobId }))
      .digest("hex"),
    deadlineAt: Date.now() + parentJobBudget(ctx, operation),
  };
  ctx.checkpointResult = { ...ctx.checkpointResult, _parentExecution: parent };
  return {
    version: 1,
    apiJobId: ctx.jobId,
    apiOwnerVersion: ctx.execution.version,
    parentOperationKey: parent.operationKey,
    parentFingerprint: parent.fingerprint,
    parentDeadlineAt: parent.deadlineAt,
    childOperationKey: key,
    childOperationFingerprint: opsOperationFingerprint(operation),
    requestedDeadlineAt: Math.min(
      parent.deadlineAt,
      Date.now() + opsExecutionBudget(operation.kind).processMs,
    ),
    attemptId: randomUUID(),
  };
}
export async function issueApiJobChildAssertion(attempt: ApiJobChildAttempt): Promise<string> {
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
  // Exact schema order and NUL-terminated domain used by verifyApiJobParentExecution.
  const payload = Buffer.from(JSON.stringify(apiJobChildAttemptSchema.parse(attempt))).toString(
    "base64url",
  );
  const signature = createHmac("sha256", token)
    .update("openmapx-api-job-parent-v1\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
