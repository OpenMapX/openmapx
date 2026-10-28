import { type ConfigurationApplyResult, configurationApplyResultSchema } from "@openmapx/core/ops";

export type TrustedConfigurationApplyOutcome = (
  | ConfigurationApplyResult
  | { outcome: "unknown"; reason: "transport_or_result" }
) & { publisherCleanupFailed: boolean; registryUpdateFailed: boolean };
export function completeTrustedConfigurationApply(
  outcome: TrustedConfigurationApplyOutcome,
): boolean {
  return (
    outcome.outcome === "committed" &&
    outcome.followUp === "complete" &&
    !outcome.cleanupFailed &&
    !outcome.publisherCleanupFailed &&
    !outcome.registryUpdateFailed
  );
}

/** Decode the exact retained API outcome, including the API-owned cleanup evidence. */
export function parseTrustedConfigurationApplyOutcome(
  value: unknown,
): TrustedConfigurationApplyOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration outcome unavailable");
  const { publisherCleanupFailed, registryUpdateFailed, ...application } = value as Record<
    string,
    unknown
  >;
  if (typeof publisherCleanupFailed !== "boolean" || typeof registryUpdateFailed !== "boolean")
    throw new Error("Configuration outcome unavailable");
  if (application.outcome === "unknown") {
    if (application.reason !== "transport_or_result" || Object.keys(application).length !== 2)
      throw new Error("Configuration outcome unavailable");
    return {
      outcome: "unknown",
      reason: "transport_or_result",
      publisherCleanupFailed,
      registryUpdateFailed,
    };
  }
  return {
    ...configurationApplyResultSchema.parse(application),
    publisherCleanupFailed,
    registryUpdateFailed,
  };
}

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
