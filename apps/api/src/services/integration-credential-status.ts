import type { AdminIntegrationCredential } from "@openmapx/core/api-contracts";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { getSecretFields } from "../utils/validate-config-body";

export function getIntegrationDisplayName(integration: {
  id: string;
  manifest: { name?: string };
  strings: Record<string, Record<string, unknown>>;
}): string {
  const name = integration.strings.en?.name;
  return typeof name === "string" ? name : (integration.manifest.name ?? integration.id);
}
/** Values never leave this service. Stored-vault audit is independent of the winning layer. */
export async function inspectIntegrationCredentialView(integration: {
  id: string;
  directory: string;
  manifest: IntegrationManifest;
}) {
  const { withAdministrativeConfigurationRead } = await import(
    "./administrative-configuration-writer-owner"
  );
  const { integrationOwnershipSnapshot } = await import("./configuration-ownership-view");
  return withAdministrativeConfigurationRead({}, async (read) => {
    const snapshot = await integrationOwnershipSnapshot(integration.id, read),
      vault = read.integrationSecretRows.filter((row) => row.integrationId === integration.id),
      byKey = new Map(vault.map((row) => [row.key, row]));
    const credentials: AdminIntegrationCredential[] = getSecretFields(
      integration.manifest.configSchema,
    ).map((field) => {
      const stored = byKey.get(field.key),
        effective = snapshot.resolved[field.key];
      return {
        ...field,
        source:
          effective &&
          effective.value !== undefined &&
          effective.value !== null &&
          effective.value !== ""
            ? effective.source
            : "missing",
        ownership: snapshot.ownership[field.key],
        updatedAt: stored?.updatedAt.toISOString(),
        updatedBy: stored?.updatedBy ?? null,
      };
    });
    return { ...snapshot, credentials };
  });
}
export async function computeCredentialStatus(integration: {
  id: string;
  directory: string;
  manifest: IntegrationManifest;
}): Promise<AdminIntegrationCredential[]> {
  return (await inspectIntegrationCredentialView(integration)).credentials;
}

export async function latestIntegrationApplication(integrationId: string) {
  const [{ db }, { adminJob }, { sql, desc }, { integrationApplyReceiptSchema }] =
    await Promise.all([
      import("../db"),
      import("../db/schema"),
      import("drizzle-orm"),
      import("@openmapx/core/api-contracts"),
    ]);
  const [last] = await db
    .select({ application: sql<unknown>`${adminJob.result}->'integrationApplication'` })
    .from(adminJob)
    .where(sql`${adminJob.result}->'integrationApplication'->>'integrationId'=${integrationId}`)
    .orderBy(desc(adminJob.createdAt), desc(adminJob.id))
    .limit(1);
  return last ? integrationApplyReceiptSchema.parse(last.application) : null;
}
