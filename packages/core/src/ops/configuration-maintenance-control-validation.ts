/** Exact metadata-control timing validation; separate from portable receipt
 * schemas so operation policy cannot become a schema initialization cycle. */
import type {
  ConfigurationMaintenanceDecision,
  ConfigurationMaintenanceSettle,
} from "./configuration-maintenance";
import {
  executionFingerprint,
  type RetainedExecutionAdmission,
  retainedParentExecutionSchema,
} from "./execution-identity";
import { opsOperationFingerprint } from "./fingerprint";

/** Data validation ONLY for the closed no-effect metadata controls. The
 * receiver still requires the actual original-owner recovery capability and
 * live exact API HMAC. Generic forward normalization remains unchanged. */
export function validateRetainedConfigurationMaintenanceRecoveryControl(
  operation: ConfigurationMaintenanceDecision | ConfigurationMaintenanceSettle,
  input: RetainedExecutionAdmission,
): void {
  if (operation.kind === "configurationMaintenance.decide" && operation.decision !== "abandon")
    throw Error("Forward continue is not a recovery control");
  const parent = retainedParentExecutionSchema.parse(input.parent);
  if (
    parent.issuer !== "api" ||
    input.executionVersion !== 2 ||
    input.operationFingerprint !== opsOperationFingerprint(operation) ||
    ![input.admittedAt, input.deadlineAt, input.requestedDeadlineAt].every(
      (value) => Number.isSafeInteger(value) && value! >= 0,
    ) ||
    !Number.isSafeInteger(input.deploymentBudgetMs) ||
    input.deploymentBudgetMs < 1 ||
    input.deploymentBudgetMs > 60000 ||
    input.deadlineAt <= input.admittedAt ||
    input.deadlineAt !==
      Math.min(input.requestedDeadlineAt!, input.admittedAt + input.deploymentBudgetMs) ||
    input.fingerprint !==
      executionFingerprint({
        kind: operation.kind,
        operationFingerprint: input.operationFingerprint,
        deadlineAt: input.deadlineAt,
        parent,
      })
  )
    throw Error("Invalid original maintenance recovery control timing");
}
