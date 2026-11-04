import {
  completeTrustedConfigurationApply,
  type TrustedConfigurationApplyOutcome,
} from "../trusted-config-outcome";
import type { MigrationResult } from "./apply";

/** Result projection only. The captured disabled targets remain pending even
 * when recovery runs after service selection has changed. Missing old evidence
 * cannot establish activation. This helper grants no execution authority. */
export function migrationCompletionResult(input: {
  operationId: string;
  steps: MigrationResult["steps"];
  pendingServiceIds?: readonly string[];
  application: TrustedConfigurationApplyOutcome;
}): MigrationResult {
  const known = input.pendingServiceIds !== undefined,
    complete = completeTrustedConfigurationApply(input.application),
    pending = new Set(input.pendingServiceIds),
    steps = input.steps.map((step) => ({
      ...step,
      status:
        step.scope === "pending-auth" ||
        (known && step.scope.startsWith("service-") && pending.has(step.id))
          ? ("pending" as const)
          : complete && known
            ? ("applied" as const)
            : ("unknown" as const),
    }));
  return {
    operationId: input.operationId,
    outcome:
      !complete || !known
        ? "unknown"
        : steps.some((step) => step.status === "pending")
          ? "partial"
          : "applied",
    steps,
  };
}
