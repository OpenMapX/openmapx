import {
  type ConfigurationApplyResult,
  configurationApplyResultSchema,
  type MissingServiceSettingsList,
  missingServiceSettingsSchema,
} from "./configuration-result-records";

/** `problem` says why a failed apply was not committed, when the operator can fix it;
 * `missingSettings` names the required settings without a value, when that was why. */
export type TrustedConfigurationApplyOutcome = (
  | ConfigurationApplyResult
  | { outcome: "unknown"; reason: "transport_or_result" }
) & {
  registryUpdateFailed: boolean;
  problem?: string;
  missingSettings?: MissingServiceSettingsList;
};
export function completeTrustedConfigurationApply(
  outcome: TrustedConfigurationApplyOutcome,
): boolean {
  return (
    outcome.outcome === "committed" &&
    outcome.followUp === "complete" &&
    !outcome.cleanupFailed &&
    !outcome.registryUpdateFailed
  );
}

/** Decode the exact retained API outcome, including the API-owned cleanup evidence. */
export function parseTrustedConfigurationApplyOutcome(
  value: unknown,
): TrustedConfigurationApplyOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration outcome unavailable");
  const { registryUpdateFailed, problem, missingSettings, ...application } = value as Record<
    string,
    unknown
  >;
  if (typeof registryUpdateFailed !== "boolean")
    throw new Error("Configuration outcome unavailable");
  if (problem !== undefined && typeof problem !== "string")
    throw new Error("Configuration outcome unavailable");
  const missing =
    missingSettings === undefined
      ? undefined
      : missingServiceSettingsSchema.safeParse(missingSettings);
  if (missing && (!missing.success || problem === undefined))
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
      registryUpdateFailed,
    };
  }
  return {
    ...configurationApplyResultSchema.parse(application),
    ...(problem === undefined ? {} : { problem }),
    ...(missing?.success ? { missingSettings: missing.data } : {}),
    registryUpdateFailed,
  };
}
