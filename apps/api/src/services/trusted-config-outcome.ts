import { REQUIRED_SETTINGS_MISSING } from "@openmapx/core/api-contracts";
import type {
  MissingServiceSettingsList,
  TrustedConfigurationApplyOutcome,
} from "@openmapx/core/ops";

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

  /** The 409 reply for a failure the operator can fix; required settings are named by service. */
  reply(): { error: string; code?: string; missingSettings?: MissingServiceSettingsList } {
    return this.outcome.missingSettings
      ? {
          error: this.message,
          code: REQUIRED_SETTINGS_MISSING,
          missingSettings: this.outcome.missingSettings,
        }
      : { error: this.message };
  }
}

/** A known local refusal before snapshot publication or mutation dispatch. */
export class TrustedConfigurationUpgradeRequired extends TrustedConfigurationApplyError {
  constructor() {
    super({
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
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
