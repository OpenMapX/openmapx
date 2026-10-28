import { ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AdminIntegrationImportFailure } from "@openmapx/core/api-contracts";

function importFailureMessage(failure: AdminIntegrationImportFailure): string {
  if (failure.recovery === "restored")
    return "Import failed. Previous saved and applied configuration was restored.";
  const saved =
    failure.phase === "persistence" && failure.database === "retained"
      ? "The saved configuration is unchanged."
      : {
          retained: "The imported configuration is saved.",
          restored: "The previous saved configuration was restored.",
          conflict: "Saved configuration changed during the import; newer edits were preserved.",
          unknown: "The saved configuration is uncertain.",
        }[failure.database];
  const applied =
    failure.runtime === "restored"
      ? "The previous running configuration was restored."
      : failure.runtime === "unchanged"
        ? "The running configuration is unchanged."
        : "The running configuration is uncertain.";
  return `Import failed. ${saved} ${applied} Review saved settings and running integrations before making further changes. Do not retry this import until the state has been checked.`;
}

/** Display only declared, validated failure fields; never stringify a response or its evidence. */
export function integrationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  if (error.status === 409) {
    const failure = sdk.adminIntegrationImportFailureSchema.safeParse(error.payload);
    if (failure.success) return importFailureMessage(failure.data);
  }
  const validation = sdk.adminIntegrationValidationErrorSchema.safeParse(error.payload);
  if (validation.success)
    return (
      validation.data.errors
        .slice(0, 8)
        .map((s) => s.slice(0, 512))
        .join("; ") || fallback
    );
  const vault = sdk.adminIntegrationVaultUnavailableSchema.safeParse(error.payload);
  if (vault.success) return `${vault.data.error.slice(0, 512)}. ${vault.data.hint.slice(0, 512)}`;
  return sdk.adminErrorMessage(error, fallback);
}
