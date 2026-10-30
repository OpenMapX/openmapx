/** Pure preview data. A fingerprint is an intent checksum, never host authority. */
import { createHash } from "node:crypto";
import z from "zod/v4";
import { canonicalJson } from "../ops/canonical-json";
import { protectedConfigurationReconcileIdsSchema } from "../ops/configuration-handoff-records";
import {
  configurationReleaseSelectionSchema,
  configurationReleaseServiceImagesSchema,
} from "../ops/configuration-release-downloads";
import { resolveProxyHost } from "./compose-renderer";
import {
  type PlatformConfiguration,
  platformConfigurationSchema,
  resolvePlatformConfiguration,
} from "./platform-configuration";
import type { LoadedService } from "./types";

const revision = z
  .string()
  .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
  .nullable();
const variables = {
  domain: "DOMAIN",
  acmeEmail: "ACME_EMAIL",
  releaseSelector: "OPENMAPX_RELEASE",
  defaultRegion: "OPENMAPX_REGION",
  backupRetentionDays: "BACKUP_RETENTION_DAYS",
} as const;
export function buildPlatformConfigurationPreview(input: {
  actorId: string;
  previewId: string;
  authPolicyRevision: string;
  sourceRevision: string;
  currentRevisionId: string | null;
  expectedCurrentRevisionId: string | null;
  currentPlatform?: PlatformConfiguration;
  changes: PlatformConfiguration;
  env: Readonly<Record<string, string | undefined>>;
  services: readonly LoadedService[];
  resolvedServiceConfigs?: Map<string, Record<string, unknown>>;
  reconcileServiceIds?: readonly string[];
  release?: { releaseId: string; manifestDigest: string };
}) {
  const currentRevisionId = revision.parse(input.currentRevisionId);
  if (revision.parse(input.expectedCurrentRevisionId) !== currentRevisionId)
    throw Error("Platform configuration revision changed");
  const actorId = z.string().min(1).max(128).parse(input.actorId);
  const previewId = z.uuid().parse(input.previewId);
  const authPolicyRevision = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.authPolicyRevision);
  const sourceRevision = z.uuid().parse(input.sourceRevision);
  const changes = platformConfigurationSchema.parse(input.changes);
  const reconcileServiceIds =
    input.reconcileServiceIds === undefined
      ? undefined
      : protectedConfigurationReconcileIdsSchema.parse(input.reconcileServiceIds);
  if (
    reconcileServiceIds?.some(
      (id) =>
        !input.services.some(
          (service) => service.isBuiltIn && service.enabled && service.manifest.id === id,
        ),
    )
  )
    throw Error("Protected reconciliation requires an enabled built-in service");
  const configuration = platformConfigurationSchema.parse({
    ...input.currentPlatform,
    ...changes,
    version: 1,
  });
  const release =
    input.release === undefined
      ? undefined
      : configurationReleaseSelectionSchema.parse(input.release);
  if (
    release &&
    (reconcileServiceIds ||
      canonicalJson(configuration) !== canonicalJson({ version: 1, ...input.currentPlatform }))
  )
    throw Error("Apply platform settings separately from a checked release");
  const before = resolvePlatformConfiguration({ saved: input.currentPlatform, env: input.env });
  const after = resolvePlatformConfiguration({ saved: configuration, env: input.env });
  const changedFields = (Object.keys(variables) as (keyof typeof variables)[]).filter(
    (key) => before.values[key] !== after.values[key],
  );
  const domain = before.values.domain !== after.values.domain;
  const affectedServiceIds = input.services
    .filter((service) => {
      if (!service.isBuiltIn || !service.enabled) return false;
      const m = service.manifest;
      if (release) return Object.hasOwn(configurationReleaseServiceImagesSchema.shape, m.id);
      if (reconcileServiceIds?.includes(m.id as (typeof reconcileServiceIds)[number])) return true;
      const consumer = JSON.stringify({
        environment: m.container.environment,
        command: m.container.command,
        entrypoint: m.container.entrypoint,
      });
      if (changedFields.some((key) => consumer.includes(`\${${variables[key]}`))) return true;
      if (domain && m.id === "traefik") return true;
      if (!domain || !m.exposure?.proxy?.enabled) return false;
      const proxy = (hostname: string) =>
        resolveProxyHost(m, {
          domain: hostname,
          resolvedServiceConfigs: input.resolvedServiceConfigs,
        }) ?? hostname;
      return proxy(before.values.domain) !== proxy(after.values.domain);
    })
    .map((service) => service.manifest.id)
    .sort();
  const oldOrigin = `https://${before.values.domain}`;
  const newOrigin = `https://${after.values.domain}`;
  const requiredConfirmation = {
    domain,
    dnsTls: domain,
    oauth: domain,
    passkeys: domain,
    alternateLogin: domain,
  };
  const originConsumers = {
    routingHost: after.values.domain,
    corsOrigin: newOrigin,
    authUrl: newOrigin,
    passkeyRpId: after.values.domain,
    passkeyOrigin: `${newOrigin},openmapx://`,
    webApiUrl: newOrigin,
    tilesPublicUrl: `${newOrigin}/tiles/`,
  };
  const warnings = [
    ...(domain
      ? [
          "Configure DNS and TLS for the new origin before applying.",
          "Update OAuth redirect registrations and retain a proven password login; origin-bound passkeys may require registration again.",
        ]
      : []),
    ...(changedFields.includes("defaultRegion")
      ? ["Changing the default region does not rebuild prepared datasets."]
      : []),
    ...(changedFields.includes("releaseSelector")
      ? [
          "Changing the release selector does not install that release. Check and apply it separately.",
        ]
      : []),
  ];
  const intent = {
    version: 1 as const,
    actorId,
    previewId,
    authPolicyRevision,
    sourceRevision,
    expectedCurrentRevisionId: currentRevisionId,
    configuration,
    values: after.values,
    sources: after.sources,
    affectedServiceIds,
    ...(reconcileServiceIds ? { reconcileServiceIds } : {}),
    ...(release ? { release } : {}),
    oldOrigin,
    newOrigin,
    originConsumers,
    requiredConfirmation,
    warnings,
  };
  const previewFingerprint = createHash("sha256")
    .update("openmapx-platform-preview-v1\0")
    .update(canonicalJson(intent))
    .digest("hex");
  return { ...intent, previewFingerprint };
}
export type PlatformConfigurationPreview = ReturnType<typeof buildPlatformConfigurationPreview>;
