import type { AdminIntegrationCredential } from "@openmapx/core/api-contracts";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { resolveConfigWithSources } from "../integration-host";
import { getSecretFields } from "../utils/validate-config-body";
import { listSecrets } from "./secrets";

export function getIntegrationDisplayName(integration: {
  id: string;
  manifest: { name?: string };
  strings: Record<string, Record<string, unknown>>;
}): string {
  const name = integration.strings.en?.name;
  return typeof name === "string" ? name : (integration.manifest.name ?? integration.id);
}
/** Values never leave this service. Stored-vault audit is independent of the winning layer. */
export async function computeCredentialStatus(integration: {
  id: string;
  directory: string;
  manifest: IntegrationManifest;
}): Promise<AdminIntegrationCredential[]> {
  const fields = getSecretFields(integration.manifest.configSchema);
  if (!fields.length) return [];
  const [resolved, vault] = await Promise.all([
    resolveConfigWithSources(integration.manifest, integration.directory),
    listSecrets(integration.id),
  ]);
  const byKey = new Map(vault.map((entry) => [entry.key, entry]));
  return fields.map((field) => {
    const stored = byKey.get(field.key);
    const effective = resolved[field.key];
    return {
      ...field,
      source:
        effective &&
        effective.value !== undefined &&
        effective.value !== null &&
        effective.value !== ""
          ? effective.source
          : "missing",
      updatedAt: stored?.updatedAt?.toISOString(),
      updatedBy: stored?.updatedBy ?? null,
    };
  });
}
