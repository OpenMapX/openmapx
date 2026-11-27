import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { installedExtension, installedExtensionComponent } from "../db/installed-extension-schema";

/** The integrations whose owning extension an operator disabled. */
export async function disabledExtensionIntegrationIds(
  database: typeof db = db,
): Promise<ReadonlySet<string>> {
  const rows = await database
    .select({ integrationId: installedExtensionComponent.componentId })
    .from(installedExtensionComponent)
    .innerJoin(
      installedExtension,
      eq(installedExtension.id, installedExtensionComponent.extensionId),
    )
    .where(
      and(
        eq(installedExtensionComponent.kind, "integration"),
        eq(installedExtension.enabled, false),
      ),
    );
  return new Set(rows.map((row) => row.integrationId));
}
