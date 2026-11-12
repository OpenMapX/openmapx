import {
  normalizeExecutionAdmission,
  type OpsOperation,
  opsExecutionBudget,
  opsOperationFingerprint,
  opsResourceId,
} from "@openmapx/core/ops";
import type { PersistedOpsJob } from "../journal";

/** A retained job with the execution identity the journal requires on load. */
export function persistedJob(
  operation: OpsOperation,
  overrides: Partial<PersistedOpsJob> & { operationId: string; operationKey: string },
): PersistedOpsJob {
  const submittedAt = overrides.submittedAt ?? "2026-08-23T18:00:00.000Z",
    admittedAt = Date.parse(submittedAt),
    operationFingerprint = opsOperationFingerprint(operation),
    deploymentBudgetMs = opsExecutionBudget(operation.kind).processMs,
    identity = normalizeExecutionAdmission({
      operationFingerprint,
      operationKey: overrides.operationKey,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: overrides.requestedDeadlineAt,
      deploymentBudgetMs,
    });
  return {
    executionVersion: 2,
    requestVersion: 2,
    ...identity,
    operationFingerprint,
    deploymentBudgetMs,
    role: "api",
    operation,
    resourceId: opsResourceId(operation),
    state: "queued",
    submittedAt,
    updatedAt: submittedAt,
    ...overrides,
  };
}
