import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AdminPlatformPreview,
  adminPlatformPreviewSchema,
  authPolicySettingsSchema,
} from "@openmapx/core/api-contracts";
import { canonicalJson, protectedConfigurationServiceIdSchema } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { sql } from "drizzle-orm";
import {
  type ConfigurationMigrationDocument,
  type ConfigurationMigrationPreview,
  configurationMigrationDocumentSchema,
} from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import {
  authPolicyKeys,
  defaultAuthPolicySettings,
  loadAuthPolicy,
} from "../../account/auth-policy";
import { systemSettings } from "../../db/schema";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  withAdministrativeConfigurationRead,
} from "../administrative-configuration-writer-owner";
import {
  integrationOwnershipSnapshot,
  serviceOwnershipSnapshot,
} from "../configuration-ownership-view";
import { bindingContentRevision, capturedBindingState } from "../integration-binding-state";
import type { ProspectiveConfigurationOverlay } from "../prospective-configuration";
import { matchesDeclaredType, SETTING_DEFS } from "../settings";
import { migrationSources } from "./sources";
import { MigrationConflict, retainMigrationStage } from "./staging";

export type MigrationPlan = {
  document: ConfigurationMigrationDocument;
  expectedCurrentRevisionId: string | null;
  sourceRevision: string;
  sourceSnapshot: import("@openmapx/core/ops").ConfigurationSourcesInspection;
  guard: string;
  overlay: ProspectiveConfigurationOverlay;
  settings: Record<string, unknown>;
  bindingVersions: Record<string, string>;
  denials: string[];
  authPolicyRevision: string;
  settingsWitness: Array<{ key: string; rowVersion: string }>;
  platformPreview?: AdminPlatformPreview;
  additionalServiceIds?: string[];
  pendingServiceIds?: string[];
};
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export async function prepareMigrationPlan(
  raw: unknown,
  writer: AdministrativeConfigurationWriter,
  retainPlatform = true,
  retainedBindingVersions?: Record<string, string>,
): Promise<MigrationPlan> {
  const document = configurationMigrationDocumentSchema.parse(raw),
    owner = administrativeConfigurationState(writer),
    source = await migrationSources();
  return withAdministrativeConfigurationRead({}, async (read) => {
    const changes: ProspectiveConfigurationOverlay["changes"] = [],
      denials: string[] = [],
      settings: Record<string, unknown> = {},
      bindingVersions: Record<string, string> = { ...retainedBindingVersions },
      observations: unknown[] = [];
    const seen = new Set<string>();
    const unique = (identity: string) => {
      if (seen.has(identity)) throw new MigrationConflict();
      seen.add(identity);
    };
    for (const installation of document.installations) {
      const target = read.integrations.find((i) => i.id === installation.integrationId);
      if (!target) {
        denials.push(`integration:${installation.integrationId}:installation_required`);
        document.prerequisites.push({
          scope: "integration",
          id: installation.integrationId,
          source: "missing",
          reason: "installation_required",
        });
      } else if (installation.version && target.manifest.version !== installation.version)
        denials.push(`integration:${installation.integrationId}:installation_version_changed`);
    }
    for (const entry of document.integrations) {
      unique(`integration:${entry.integrationId}`);
      if (!read.integrations.some((i) => i.id === entry.integrationId)) {
        denials.push(`integration:${entry.integrationId}:installation_required`);
        continue;
      }
      const snapshot = await integrationOwnershipSnapshot(entry.integrationId, read);
      observations.push({
        id: entry.integrationId,
        revision: snapshot.revision,
        ownership: snapshot.ownership,
      });
      for (const key of Object.keys(entry.config))
        if (!snapshot.ownership[key]?.writable || snapshot.ownership[key]?.secret)
          denials.push(`integration:${entry.integrationId}:${key}:not_portable`);
      changes.push({
        kind: "integration-config",
        integrationId: entry.integrationId,
        set: entry.config,
        unset: [],
      });
    }
    for (const entry of document.serviceConfigs) {
      unique(`service:${entry.serviceId}`);
      if (!read.services.some((s) => s.manifest.id === entry.serviceId)) {
        denials.push(`service:${entry.serviceId}:installation_required`);
        continue;
      }
      const snapshot = await serviceOwnershipSnapshot(entry.serviceId, read, source);
      observations.push({ id: entry.serviceId, ownership: snapshot.ownership });
      for (const key of Object.keys(entry.config))
        if (!snapshot.ownership[key]?.writable || snapshot.ownership[key]?.secret)
          denials.push(`service:${entry.serviceId}:${key}:not_portable`);
      changes.push({
        kind: "service-config",
        serviceId: entry.serviceId,
        set: entry.config,
        unset: [],
      });
    }
    for (const prerequisite of document.prerequisites) {
      if (prerequisite.reason !== "credential_required" || !prerequisite.key) continue;
      const dependent =
        prerequisite.scope === "integration"
          ? document.integrations.some((e) => e.integrationId === prerequisite.id)
          : prerequisite.scope === "service"
            ? document.serviceConfigs.some((e) => e.serviceId === prerequisite.id)
            : false;
      if (!dependent) continue;
      const target =
        prerequisite.scope === "integration"
          ? read.integrations.some((i) => i.id === prerequisite.id)
          : read.services.some((s) => s.manifest.id === prerequisite.id);
      if (!target) continue;
      const snapshot =
          prerequisite.scope === "integration"
            ? await integrationOwnershipSnapshot(prerequisite.id, read)
            : await serviceOwnershipSnapshot(prerequisite.id, read, source),
        field = snapshot.resolved[prerequisite.key],
        ownership = snapshot.ownership[prerequisite.key];
      if (
        !ownership?.secret ||
        (!["env", "config.json"].includes(ownership.source) &&
          (!field || field.value === null || field.value === undefined || field.value === ""))
      )
        denials.push(
          `${prerequisite.scope}:${prerequisite.id}:${prerequisite.key}:credential_required`,
        );
    }
    const existingSettings = await owner.connection
        .select({
          key: systemSettings.key,
          value: systemSettings.value,
          rowVersion: sql<string>`xmin::text`,
        })
        .from(systemSettings),
      policy = await loadAuthPolicy(owner.connection);
    for (const [key, value] of Object.entries(document.settings)) {
      const def = SETTING_DEFS.find((d) => d.key === key);
      if (
        !def ||
        def.secret ||
        (def.env && read.env[def.env] !== undefined) ||
        !matchesDeclaredType(def, value)
      )
        denials.push(`account:settings:${key}:not_portable`);
      else settings[key] = value;
    }
    const authDraft = Object.fromEntries(
      existingSettings.filter((r) => authPolicyKeys.includes(r.key)).map((r) => [r.key, r.value]),
    );
    authPolicySettingsSchema.parse({
      ...defaultAuthPolicySettings,
      ...authDraft,
      ...Object.fromEntries(
        Object.entries(settings).filter(([key]) => authPolicyKeys.includes(key)),
      ),
    });
    for (const binding of document.bindings) {
      unique(`binding:${binding.integrationId}:${binding.capability}`);
      const integration = read.integrations.find((i) => i.id === binding.integrationId),
        service = read.services.find((s) => s.manifest.id === binding.serviceId);
      if (
        !integration?.manifest.requires?.some((r) => r.capability === binding.capability) ||
        !service?.enabled ||
        !services.getProvidedCapabilityNames(service.manifest.provides).includes(binding.capability)
      ) {
        denials.push(`integration:${binding.integrationId}:${binding.capability}:missing_provider`);
        continue;
      }
      bindingVersions[binding.integrationId] ??= randomUUID();
      const before = capturedBindingState(read, binding.integrationId),
        version = bindingVersions[binding.integrationId],
        next = {
          ...before.bindings,
          ...Object.fromEntries(
            document.bindings
              .filter((b) => b.integrationId === binding.integrationId)
              .map((b) => [b.capability, b.serviceId]),
          ),
        };
      changes.push({
        kind: "integration-binding",
        ...binding,
        expectedServiceId: before.bindings[binding.capability] ?? null,
        expectedRevision: before.revision,
        nextVersion: version,
        desiredRevision: bindingContentRevision(binding.integrationId, next),
      });
    }
    let platformPreview: AdminPlatformPreview | undefined;
    const additionalServiceIds = document.serviceConfigs
      .filter((e) => read.services.some((s) => s.manifest.id === e.serviceId && s.enabled))
      .map((e) => e.serviceId)
      .sort();
    if (
      (document.platform &&
        canonicalJson(document.platform) !== canonicalJson(source.platform ?? { version: 1 })) ||
      additionalServiceIds.some((id) => protectedConfigurationServiceIdSchema.safeParse(id).success)
    ) {
      const resolved = new Map<string, Record<string, unknown>>();
      for (const service of read.services) {
        const snapshot = await serviceOwnershipSnapshot(service.manifest.id, read, source);
        resolved.set(service.manifest.id, {
          ...Object.fromEntries(
            Object.entries(snapshot.resolved).map(([key, value]) => [key, value.value]),
          ),
          ...document.serviceConfigs.find((e) => e.serviceId === service.manifest.id)?.config,
        });
      }
      platformPreview = adminPlatformPreviewSchema.parse(
        services.buildPlatformConfigurationPreview({
          actorId: writer.actorId,
          previewId: randomUUID(),
          authPolicyRevision: policy.revision,
          sourceRevision: source.sourceRevision,
          currentRevisionId: source.revisionId,
          expectedCurrentRevisionId: source.revisionId,
          currentPlatform: source.platform,
          changes: document.platform ?? source.platform ?? { version: 1 },
          env: read.env,
          services: read.services,
          resolvedServiceConfigs: resolved,
          additionalServiceIds,
        }),
      );
      if (retainPlatform) {
        const { retainPlatformPreview } = await import("../platform-preview-store");
        const retained = await retainPlatformPreview({
          actorId: writer.actorId,
          operationKey: writer.operationKey,
          requestFingerprint: digest({ document: document.platform ?? null, additionalServiceIds }),
          preview: platformPreview,
          sourceSnapshot: source,
          desiredRowVersion:
            existingSettings.find((r) => r.key === "platformConfiguration")?.rowVersion ?? null,
        });
        platformPreview = retained.preview;
      }
      const { version: _version, ...patch } = platformPreview.configuration;
      changes.push({ kind: "platform", patch });
    }
    if (changes.length > 512) denials.push("migration:maximum_512_changes");
    const guard = digest({
      services: read.services.map((s) => ({ manifest: s.manifest, enabled: s.enabled })),
      integrations: read.integrations.map((i) => ({
        id: i.id,
        manifest: i.manifest,
        directory: i.directory,
      })),
      serviceRows: read.serviceRows,
      integrationRows: read.integrationRows,
      serviceSecretRows: read.serviceSecretRows,
      integrationSecretRows: read.integrationSecretRows,
      bindings: read.bindingRows,
      bindingRevisions: read.bindingRevisionRows,
      settings: existingSettings,
      observations,
      authPolicyRevision: policy.revision,
      settingsWitness: existingSettings
        .map((r) => ({ key: r.key, rowVersion: r.rowVersion }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      sourceOwnership: source.services,
      platformOwnership: source.platform ?? null,
    });
    return {
      document,
      expectedCurrentRevisionId: source.revisionId,
      sourceRevision: source.sourceRevision,
      sourceSnapshot: source,
      guard,
      overlay: { purpose: "migration", coordinatorMode: "ensure-running", changes },
      settings,
      bindingVersions,
      ...(platformPreview ? { platformPreview, additionalServiceIds } : {}),
      pendingServiceIds: document.serviceConfigs
        .filter((e) => read.services.some((s) => s.manifest.id === e.serviceId && !s.enabled))
        .map((e) => e.serviceId),
      denials,
      authPolicyRevision: policy.revision,
      settingsWitness: existingSettings
        .map((r) => ({ key: r.key, rowVersion: r.rowVersion }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  });
}
export async function previewConfigurationMigration(
  raw: unknown,
  actorId: string,
  writer: AdministrativeConfigurationWriter,
) {
  const plan = await prepareMigrationPlan(raw, writer),
    stage = plan.denials.length
      ? {
          previewId: randomUUID(),
          fingerprint: randomBytes(32).toString("hex"),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        }
      : await retainMigrationStage({ actorId, kind: "migration", value: plan });
  return migrationPlanPreview(stage, plan);
}
export function migrationPlanPreview(
  stage: { previewId: string; fingerprint: string; expiresAt: string },
  plan: MigrationPlan,
): ConfigurationMigrationPreview {
  return {
    previewId: stage.previewId,
    fingerprint: stage.fingerprint,
    expectedCurrentRevisionId: plan.expectedCurrentRevisionId,
    expiresAt: stage.expiresAt,
    denials: plan.denials,
    ...(plan.platformPreview ? { platform: plan.platformPreview } : {}),
    prerequisites: plan.document.prerequisites,
    changes: [
      ...plan.overlay.changes.map((change) => ({
        scope: change.kind,
        id:
          "integrationId" in change
            ? change.integrationId
            : "serviceId" in change
              ? change.serviceId
              : "platform",
        keys:
          "set" in change
            ? Object.keys(change.set)
            : "capability" in change
              ? [change.capability]
              : [],
      })),
      ...Object.keys(plan.settings).map((key) => ({
        scope: authPolicyKeys.includes(key) ? "pending-auth" : "settings",
        id: key,
        keys: [key],
      })),
    ],
  };
}
