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

/** Only explicit local/host evidence permits callers to consider DB restoration. */
export function isProvenConfigurationNonCommit(error: unknown): boolean {
  return (
    error instanceof TrustedConfigurationApplyError && error.outcome.outcome === "not_committed"
  );
}
