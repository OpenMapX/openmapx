import { ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";

/** Display only declared, validated failure fields; never stringify a response or its evidence. */
export function integrationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
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
