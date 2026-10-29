import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  apiJobChildAttemptSchema,
  canonicalJson,
  createControlRootOperationKey,
  type OpsOperation,
  type OpsOperationKind,
  opsExecutionBudget,
  opsOperationFingerprint,
  readOpsTokenFile,
} from "@openmapx/core/ops";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";

export { type ApiJobChildAttempt, apiJobChildAttemptSchema } from "@openmapx/core/ops";

import type { ApiJobChildAttempt } from "@openmapx/core/ops";

function parentJobBudget(ctx: JobContext, kind: OpsOperationKind): number {
  if (ctx.jobType === "standalone.adopt" || ctx.jobType === "standalone.remove")
    return (
      opsExecutionBudget("integration.inspectOwnership").processMs +
      opsExecutionBudget("integration.remove").processMs +
      opsExecutionBudget("integration.settle").processMs +
      60000
    );
  if (ctx.jobType === "standalone.install")
    return (
      opsExecutionBudget("integration.install").processMs +
      opsExecutionBudget("integration.settle").processMs +
      60000
    );
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
  return opsExecutionBudget(kind).processMs;
}
export interface ApiPreparedRoot {
  operationKey: string;
  requestedDeadlineAt: number;
  parent: { operationKey: string; fingerprint: string; deadlineAt: number };
}
/** Pure preparation. Sealed configuration claims need the final key before
 * preparing their body; the complete candidate is still committed in one CAS. */
export function prepareApiJobRoot(
  ctx: JobContext,
  kind: OpsOperationKind,
  stepAddress: string,
): ApiPreparedRoot {
  if (!ctx.execution) throw Error("A durable administrative job owner is required");
  const retained = ctx.checkpointResult?._parentExecution as ApiPreparedRoot["parent"] | undefined;
  const parent = retained ?? {
    operationKey: createDurableOpsKey("admin-job.parent", ctx.jobId),
    fingerprint: createHash("sha256")
      .update(canonicalJson({ jobId: ctx.jobId }))
      .digest("hex"),
    deadlineAt: Date.now() + parentJobBudget(ctx, kind),
  };
  const requestedDeadlineAt = Math.min(
    parent.deadlineAt,
    Date.now() + opsExecutionBudget(kind).processMs,
  );
  const nonce = createHash("sha256")
    .update("openmapx-api-control-root-nonce-v1\0")
    .update(canonicalJson({ jobId: ctx.jobId, stepAddress }))
    .digest()
    .subarray(0, 16);
  return {
    operationKey: createControlRootOperationKey({ notAfter: requestedDeadlineAt, nonce }),
    requestedDeadlineAt,
    parent,
  };
}
/** These non-secret fields are checkpointed before the assertion is minted. */
export function prepareApiJobChildAttempt(
  ctx: JobContext,
  operation: OpsOperation,
  key: string,
  prepared?: ApiPreparedRoot,
): ApiJobChildAttempt | undefined {
  if (!ctx.execution) return undefined;
  const root = prepared ?? prepareApiJobRoot(ctx, operation.kind, key);
  return apiJobChildAttemptSchema.parse({
    version: 1,
    apiJobId: ctx.jobId,
    apiOwnerVersion: ctx.execution.version,
    parentOperationKey: root.parent.operationKey,
    parentFingerprint: root.parent.fingerprint,
    parentDeadlineAt: root.parent.deadlineAt,
    childOperationKey: key,
    childOperationFingerprint: opsOperationFingerprint(operation),
    requestedDeadlineAt: root.requestedDeadlineAt,
    attemptId: randomUUID(),
  });
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
