import z from "zod/v4";
import type { ManifestValidationResult } from "./manifest-schema";

// `extension.json` — the Extension *bundle* primitive. One versioned, pinned,
// atomically-installed unit that ties together N integrations (in-process,
// `.tar.gz` artifacts) and N services (containers, git repos) plus their config
// and cross-part readiness. The bundle never re-packages the parts — it points
// at the authoritative integration artifact (sha256-pinned) and service repo
// (git ref-pinned). See docs/plans/extensions/extension-json-spec.md.

const ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;
// Git tag or commit SHA — matches the version/ref grammar used elsewhere
// (apps/api store.ts VERSION_REF_REGEX).
const REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;
// `service:<id>` | `integration:<id>` — the component a config key / readiness
// requirement targets.
const COMPONENT_TARGET_REGEX = /^(service|integration):[a-z0-9][a-z0-9-]*$/;

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

function isGitUrl(s: string): boolean {
  try {
    const p = new URL(s).protocol;
    return p === "https:" || p === "http:" || p === "git:" || p === "ssh:";
  } catch {
    return false;
  }
}

const serviceComponentSchema = z.object({
  // Authoritative git repo for the service (cloned + ref-pinned at install).
  repo: z.string().refine(isGitUrl, "must be a git URL"),
  // Pinned tag or commit SHA. Optional: when absent the installer pins to the
  // resolved HEAD SHA at install time (so it is still immutable until updated).
  ref: z.string().regex(REF_REGEX, "must be a tag or commit ref").optional(),
  // Which service.json in that repo to enable.
  service: z.string().regex(ID_REGEX, "must be a valid service id"),
});

const integrationComponentSchema = z.object({
  // Prebuilt `.tar.gz` artifact (immutable). HTTPS only.
  artifact: z.string().refine(isHttpsUrl, "must be an https artifact URL"),
  // Optional but recommended checksum, verified before extraction.
  sha256: z.string().regex(SHA256_REGEX, "must be a 64-char hex sha256").optional(),
  // The integration id (manifest id) this artifact installs.
  id: z.string().regex(ID_REGEX, "must be a valid integration id"),
});

const configEntrySchema = z.object({
  key: z.string().min(1),
  // Which component this bundle-level config value is forwarded to.
  target: z.string().regex(COMPONENT_TARGET_REGEX, "must be 'service:<id>' or 'integration:<id>'"),
  default: z.string().optional(),
});

const readinessSchema = z.object({
  // Components that must be up for the extension to be "ready".
  requires: z
    .array(z.string().regex(COMPONENT_TARGET_REGEX, "must be 'service:<id>' or 'integration:<id>'"))
    .optional(),
  // Integration whose registerHealthCheck() gates overall readiness.
  integrationHealth: z.string().regex(ID_REGEX).optional(),
});

export const extensionManifestSchema = z
  .object({
    id: z.string().min(1).regex(ID_REGEX, "must be lowercase, hyphen-separated"),
    name: z.string().min(1),
    version: z.string().min(1),
    // Minimum PLATFORM_VERSION (checked at install via satisfiesPlatformVersion).
    platform: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().url().optional(),

    services: z.array(serviceComponentSchema).optional(),
    integrations: z.array(integrationComponentSchema).optional(),

    config: z.array(configEntrySchema).optional(),
    readiness: readinessSchema.optional(),
  })
  .refine(
    (m) => (m.services?.length ?? 0) + (m.integrations?.length ?? 0) >= 1,
    "an extension must declare at least one component (a service or an integration)",
  );

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionServiceComponent = z.infer<typeof serviceComponentSchema>;
export type ExtensionIntegrationComponent = z.infer<typeof integrationComponentSchema>;

export interface ExtensionComponentRef {
  kind: "service" | "integration";
  id: string;
}

/**
 * Flatten a bundle into an ordered component list (services first, then
 * integrations) — the install order, and the shape the catalog card + the
 * installed-extension record use.
 */
export function extensionComponentSummary(m: ExtensionManifest): ExtensionComponentRef[] {
  return [
    ...(m.services ?? []).map((s) => ({ kind: "service" as const, id: s.service })),
    ...(m.integrations ?? []).map((i) => ({ kind: "integration" as const, id: i.id })),
  ];
}

export function validateExtensionManifest(raw: unknown): ManifestValidationResult {
  const result = extensionManifestSchema.safeParse(raw);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };
  }
  return { valid: true, errors: [] };
}
