import type { services as coreServices } from "@openmapx/core/server";
import { db } from "../db";
import { installedExtensionComponent } from "../db/schema";

export class ExtensionComponentOwnershipError extends Error {
  override readonly name = "ExtensionComponentOwnershipError";
}

/**
 * One installed component belongs to exactly one extension.
 *
 * The unique index on `(kind, component_id)` is the durable guarantee. This
 * check exists so the conflict is named and refused *before* anything is
 * mutated, instead of surfacing as a constraint violation partway through an
 * install that has already published repositories and started containers.
 */
export async function assertComponentOwnership(
  extensionId: string,
  components: readonly coreServices.ExtensionComponentRef[],
): Promise<void> {
  if (components.length === 0) return;
  const owned = await db
    .select({
      extensionId: installedExtensionComponent.extensionId,
      kind: installedExtensionComponent.kind,
      componentId: installedExtensionComponent.componentId,
    })
    .from(installedExtensionComponent);
  const conflicts = components
    .filter((component) =>
      owned.some(
        (row) =>
          row.kind === component.kind &&
          row.componentId === component.id &&
          row.extensionId !== extensionId,
      ),
    )
    .map((component) => `${component.kind}:${component.id}`);
  if (conflicts.length > 0) {
    throw new ExtensionComponentOwnershipError(
      `Component(s) already installed by another extension: ${conflicts.join(", ")}`,
    );
  }
}
