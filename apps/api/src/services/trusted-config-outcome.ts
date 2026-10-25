import type { ConfigurationApplyResult } from "@openmapx/core/ops";

export type TrustedConfigurationApplyOutcome = (
  | ConfigurationApplyResult
  | { outcome: "unknown"; reason: "transport_or_result" }
) & { publisherCleanupFailed: boolean; registryUpdateFailed: boolean };

export class TrustedConfigurationApplyError extends Error {
  constructor(readonly outcome: TrustedConfigurationApplyOutcome) {
    super(
      outcome.outcome === "not_committed"
        ? "Trusted configuration unavailable"
        : "Trusted configuration requires reconciliation",
    );
    this.name = "TrustedConfigurationApplyError";
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
