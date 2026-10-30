/** Read-only acquisition plus immutable, actor-bound reviewed previews. */
import { createHash, randomUUID } from "node:crypto";
import { adminPlatformPreviewInputSchema } from "@openmapx/core/api-contracts";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq, sql } from "drizzle-orm";
import { loadAuthPolicy } from "../account/auth-policy";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { withAdministrativeConfigurationRead } from "./administrative-configuration-writer-owner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import { PLATFORM_CONFIGURATION_SETTING } from "./platform-configuration";
import { PlatformPreviewConflict, retainPlatformPreview } from "./platform-preview-store";
import { resolveAllServiceConfigsStrict } from "./service-config-resolver";

async function source() {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.sources.inspect" },
    createDurableOpsKey("platform.sources", randomUUID()),
  );
}
export async function inspectPlatformConfiguration() {
  const current = await source();
  const effective = services.resolvePlatformConfiguration({
    saved: current.platform,
    env: process.env,
  });
  return {
    expectedCurrentRevisionId: current.revisionId,
    configuration: current.platform ?? { version: 1 as const },
    values: effective.values,
    sources: effective.sources,
  };
}
export async function previewPlatformConfiguration(input: {
  actorId: string;
  operationKey: string;
  expectedCurrentRevisionId: string | null;
  changes: services.PlatformConfiguration;
  reconcileServiceIds?: readonly string[];
}) {
  const parsed = adminPlatformPreviewInputSchema.parse({
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      changes: input.changes,
      ...(input.reconcileServiceIds ? { reconcileServiceIds: input.reconcileServiceIds } : {}),
    }),
    current = await source();
  if (parsed.expectedCurrentRevisionId !== current.revisionId) throw new PlatformPreviewConflict();
  const policy = await loadAuthPolicy(db);
  const [desired] = await db
    .select({ version: sql<string>`xmin::text` })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
  const preview = await withAdministrativeConfigurationRead({}, async (read) => {
    const resolved = await resolveAllServiceConfigsStrict(
      read.services.map((service) => ({
        id: service.manifest.id,
        configSchema: service.manifest.configSchema,
        containerEnv: service.manifest.container.environment,
        containerMemory: service.manifest.container.memory,
        isBuiltIn: service.isBuiltIn,
        proxyHostConfigKey: service.manifest.exposure?.proxy?.host?.configKey,
      })),
      read,
    );
    return services.buildPlatformConfigurationPreview({
      actorId: input.actorId,
      previewId: randomUUID(),
      authPolicyRevision: policy.revision,
      sourceRevision: current.sourceRevision,
      currentRevisionId: current.revisionId,
      expectedCurrentRevisionId: parsed.expectedCurrentRevisionId,
      currentPlatform: current.platform,
      changes: parsed.changes,
      ...(parsed.reconcileServiceIds ? { reconcileServiceIds: parsed.reconcileServiceIds } : {}),
      env: read.env,
      services: read.services,
      resolvedServiceConfigs: resolved.values,
    });
  });
  const retained = await retainPlatformPreview({
    actorId: input.actorId,
    operationKey: input.operationKey,
    requestFingerprint: createHash("sha256").update(canonicalJson(parsed)).digest("hex"),
    preview,
    sourceSnapshot: current,
    desiredRowVersion: desired?.version ?? null,
  });
  return { preview: retained.preview, expiresAt: retained.expiresAt };
}
