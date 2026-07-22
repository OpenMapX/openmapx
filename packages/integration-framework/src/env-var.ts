/**
 * Canonical env-var name for an integration config key.
 * Both the integration id and the key are hyphen-normalized to underscores and
 * upper-cased, so a region-first key like `de-tankerkoenig-api-key` maps to
 * `INTEGRATION_FUEL_DE_TANKERKOENIG_API_KEY`. Bare camelCase keys (no hyphens)
 * are unaffected, preserving existing `INTEGRATION_X_APIKEY` names.
 */
export function integrationEnvVarName(integrationId: string, key: string): string {
  const norm = (s: string) => s.replace(/-/g, "_").toUpperCase();
  return `INTEGRATION_${norm(integrationId)}_${norm(key)}`;
}
