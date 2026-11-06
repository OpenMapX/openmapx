import type { TrustedConfigurationApplyOutcome } from "@openmapx/core/ops";

export {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
  type TrustedConfigurationApplyOutcome,
} from "@openmapx/core/ops";

export class TrustedConfigurationApplyError extends Error {
  /** A failure the operator can fix answers 409 with its reason; any other stays a 500. */
  readonly statusCode?: number;

  constructor(readonly outcome: TrustedConfigurationApplyOutcome) {
    super(
      outcome.outcome === "not_committed"
        ? (outcome.problem ?? "Trusted configuration unavailable")
        : "Trusted configuration requires reconciliation",
    );
    this.name = "TrustedConfigurationApplyError";
    if (outcome.outcome === "not_committed" && outcome.problem) this.statusCode = 409;
  }
}

/** A known local refusal before snapshot publication or mutation dispatch. */
export class TrustedConfigurationUpgradeRequired extends TrustedConfigurationApplyError {
  constructor() {
    super({
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    });
    this.name = "TrustedConfigurationUpgradeRequired";
    this.message =
      "Update this configuration producer to use a durable administrative job before submitting the mutation.";
  }
}

/** Only explicit local/host evidence permits callers to consider DB restoration. */
export function isProvenConfigurationNonCommit(error: unknown): boolean {
  return (
    error instanceof TrustedConfigurationApplyError && error.outcome.outcome === "not_committed"
  );
}
