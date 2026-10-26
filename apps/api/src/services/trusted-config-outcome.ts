import type { ConfigurationApplyResult } from "@openmapx/core/ops";

export type TrustedConfigurationApplyOutcome = (
  | ConfigurationApplyResult
  | { outcome: "unknown"; reason: "transport_or_result" }
) & {
  publisherCleanupFailed: boolean;
  registryUpdateFailed: boolean;
  /** Why it was not committed, when the operator can fix it (an override render may not use). */
  problem?: string;
};

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

/** Only explicit local/host evidence permits callers to consider DB restoration. */
export function isProvenConfigurationNonCommit(error: unknown): boolean {
  return (
    error instanceof TrustedConfigurationApplyError && error.outcome.outcome === "not_committed"
  );
}
