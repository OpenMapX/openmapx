import {
  type ConfigurationApplyResult,
  configurationApplyResultSchema,
} from "./configuration-result-records";

export type TrustedConfigurationApplyOutcome = (
  | ConfigurationApplyResult
  | { outcome: "unknown"; reason: "transport_or_result" }
) & { publisherCleanupFailed: boolean; registryUpdateFailed: boolean; problem?: string };
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
  const { publisherCleanupFailed, registryUpdateFailed, problem, ...application } = value as Record<
    string,
    unknown
  >;
  if (typeof publisherCleanupFailed !== "boolean" || typeof registryUpdateFailed !== "boolean")
    throw new Error("Configuration outcome unavailable");
  if (problem !== undefined && typeof problem !== "string")
    throw new Error("Configuration outcome unavailable");
  if (
    problem !== undefined &&
    (application.outcome !== "not_committed" || application.reason !== "failed")
  )
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
    ...(problem === undefined ? {} : { problem }),
    publisherCleanupFailed,
    registryUpdateFailed,
  };
}
