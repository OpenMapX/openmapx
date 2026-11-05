import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import {
  installedExtension,
  installedExtensionComponent,
  installedIntegration,
} from "../../db/schema";

type Connection = Pick<typeof db, "select" | "execute">;
export async function ownershipSnapshot(tx: Connection, id: string) {
  const [integration] = await tx
    .select({
      id: installedIntegration.id,
      installedVersion: installedIntegration.installedVersion,
      managedByExtension: installedIntegration.managedByExtension,
      repository: installedIntegration.repository,
      sourceType: installedIntegration.sourceType,
      xmin: sql<string>`xmin::text`,
    })
    .from(installedIntegration)
    .where(eq(installedIntegration.id, id))
    .for("update");
  const components = await tx
    .select({
      extensionId: installedExtensionComponent.extensionId,
      kind: installedExtensionComponent.kind,
      componentId: installedExtensionComponent.componentId,
      xmin: sql<string>`xmin::text`,
    })
    .from(installedExtensionComponent)
    .where(
      and(
        eq(installedExtensionComponent.kind, "integration"),
        eq(installedExtensionComponent.componentId, id),
      ),
    )
    .for("update");
  const parentId = components[0]?.extensionId ?? integration?.managedByExtension ?? null;
  const parents = parentId
    ? await tx
        .select({
          id: installedExtension.id,
          installationKind: installedExtension.installationKind,
          sourceTrust: installedExtension.sourceTrust,
          provenance: installedExtension.provenance,
          lastOperationId: installedExtension.lastOperationId,
          xmin: sql<string>`xmin::text`,
        })
        .from(installedExtension)
        .where(eq(installedExtension.id, parentId))
        .for("update")
    : [];
  return { integration: integration ?? null, components, parent: parents[0] ?? null };
}
export async function lockOwnership(tx: Connection, id: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`standalone-bookkeeping:${id}`},0))`,
  );
}
