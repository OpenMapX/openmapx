/** Finite unchanged-platform preview for protected config/vault recreation.
 * It adds the existing handoff producer to the SAME staged generation. */
import { createHash, randomUUID } from "node:crypto";
import { adminPlatformPreviewSchema } from "@openmapx/core/api-contracts";
import { type ConfigurationSourcesInspection, canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { sql } from "drizzle-orm";
import { loadAuthPolicy } from "../../account/auth-policy";
import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import type { AdministrativeConfigurationReadContext } from "../administrative-configuration-writer-owner";
import { serviceOwnershipSnapshot } from "../configuration-ownership-view";
import { retainPlatformPreview } from "../platform-preview-store";
export async function previewProtectedCredentialMigration(input: {
  actorId: string;
  read: AdministrativeConfigurationReadContext;
  source: ConfigurationSourcesInspection;
  serviceIds: string[];
}) {
  const values = new Map<string, Record<string, unknown>>();
  for (const service of input.read.services) {
    const snapshot = await serviceOwnershipSnapshot(service.manifest.id, input.read, input.source);
    values.set(
      service.manifest.id,
      Object.fromEntries(
        Object.entries(snapshot.resolved).map(([key, value]) => [key, value.value]),
      ),
    );
  }
  const policy = await loadAuthPolicy(db),
    [desired] = await db
      .select({ version: sql<string>`xmin::text` })
      .from(systemSettings)
      .where(sql`${systemSettings.key}='platformConfiguration'`);
  const preview = adminPlatformPreviewSchema.parse(
    services.buildPlatformConfigurationPreview({
      actorId: input.actorId,
      previewId: randomUUID(),
      authPolicyRevision: policy.revision,
      sourceRevision: input.source.sourceRevision,
      currentRevisionId: input.source.revisionId,
      expectedCurrentRevisionId: input.source.revisionId,
      currentPlatform: input.source.platform,
      changes: input.source.platform ?? { version: 1 },
      env: input.read.env,
      services: input.read.services,
      resolvedServiceConfigs: values,
      additionalServiceIds: input.serviceIds,
    }),
  );
  return (
    await retainPlatformPreview({
      actorId: input.actorId,
      operationKey: randomUUID(),
      requestFingerprint: createHash("sha256")
        .update(canonicalJson({ kind: "credential-import", ids: input.serviceIds }))
        .digest("hex"),
      preview,
      sourceSnapshot: input.source,
      desiredRowVersion: desired?.version ?? null,
    })
  ).preview;
}
