import z from "zod/v4";
import { componentIdSchema, isComponentId } from "./identifiers";
import { platformVersionSchema } from "./platform";
import { semverSchema } from "./semver";
import type { ManifestValidationResult } from "./service";

export { compareSemver, isSemver, semverSchema } from "./semver";

// `extension.json` — the Extension *bundle* primitive. One versioned, pinned,
// atomically-installed unit that ties together N integrations (in-process,
// `.tar.gz` artifacts) and N services (containers, git repos) plus their config
// and cross-part readiness. The bundle never re-packages the parts — it points
// at the authoritative integration artifact (sha256-pinned) and service repo
// (git ref-pinned). See "Bundle it as an extension" in
// docs/docs/developer/building-an-external-extension.md.

// Git tag or commit SHA.
const REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;
// `service:<id>` | `integration:<id>` — the component a config key / readiness
// requirement targets.
const COMPONENT_TARGET_MESSAGE = "must be 'service:<id>' or 'integration:<id>'";
const componentTargetSchema = z
  .string()
  .regex(/^(service|integration):[a-z0-9]+(-[a-z0-9]+)*$/, COMPONENT_TARGET_MESSAGE)
  .refine((value) => isComponentId(value.slice(value.indexOf(":") + 1)), COMPONENT_TARGET_MESSAGE);

function parsePortableExtensionUrl(s: string): URL | null {
  if (s.length > 2048) return null;
  try {
    const url = new URL(s);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Canonicalize an extension locator without ever reflecting rejected input. */
export function canonicalExtensionLocator(value: string): string {
  const parsed = parsePortableExtensionUrl(value);
  if (!parsed) throw new Error("Invalid extension locator");
  return parsed.href;
}

/** A credential-free HTTPS locator that is safe to persist and portable across hosts. */
export const extensionLocatorSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => parsePortableExtensionUrl(value) !== null,
    "must be a credential-free https URL without query or fragment",
  );

const serviceComponentSchema = z.object({
  // Authoritative git repo for the service (cloned + ref-pinned at install).
  repo: extensionLocatorSchema,
  // Pinned tag or commit SHA. Optional: when absent the installer pins to the
  // resolved HEAD SHA at install time (so it is still immutable until updated).
  ref: z.string().regex(REF_REGEX, "must be a tag or commit ref").optional(),
  // Which service.json in that repo to enable.
  service: componentIdSchema,
});

const integrationComponentSchema = z.object({
  // Prebuilt `.tar.gz` artifact (immutable). HTTPS only.
  artifact: extensionLocatorSchema,
  // Mandatory content pin, verified before extraction.
  sha256: z.string().regex(SHA256_REGEX, "must be a 64-char hex sha256"),
  // The integration id (manifest id) this artifact installs.
  id: componentIdSchema,
});

const configEntrySchema = z.object({
  key: z.string().min(1),
  // Which component this bundle-level config value is forwarded to.
  target: componentTargetSchema,
  default: z.string().optional(),
});

const readinessSchema = z.object({
  // Components that must be up for the extension to be "ready".
  requires: z.array(componentTargetSchema).optional(),
  // Integration whose registerHealthCheck() gates overall readiness.
  integrationHealth: componentIdSchema.optional(),
});

/**
 * A verified catalog entry. Verified trust comes from immutable content, never
 * from where the entry was fetched: the entry names an exact manifest and the
 * exact SHA-256 of its bytes, and carries no field that could raise its own
 * trust. Anything else is community trust.
 */
export const verifiedCatalogEntrySchema = z
  .object({
    id: componentIdSchema,
    version: semverSchema,
    manifest: extensionLocatorSchema,
    manifestSha256: z.string().regex(SHA256_REGEX, "must be a 64-char hex sha256"),
    platform: platformVersionSchema.optional(),
  })
  .strict();

export type VerifiedCatalogEntry = z.infer<typeof verifiedCatalogEntrySchema>;

function declaredComponents(m: {
  services?: Array<{ service: string }>;
  integrations?: Array<{ id: string }>;
}): { services: Set<string>; integrations: Set<string> } {
  return {
    services: new Set((m.services ?? []).map((s) => s.service)),
    integrations: new Set((m.integrations ?? []).map((i) => i.id)),
  };
}

export const extensionManifestSchema = z
  .object({
    id: componentIdSchema,
    name: z.string().min(1),
    version: semverSchema,
    // Minimum PLATFORM_VERSION (checked at install via satisfiesPlatformVersion).
    platform: platformVersionSchema,
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().url().optional(),

    services: z.array(serviceComponentSchema).optional(),
    integrations: z.array(integrationComponentSchema).optional(),

    config: z.array(configEntrySchema).optional(),
    readiness: readinessSchema.optional(),
  })
  .strict()
  .refine(
    (m) => (m.services?.length ?? 0) + (m.integrations?.length ?? 0) >= 1,
    "an extension must declare at least one component (a service or an integration)",
  )
  // One installed component must belong to exactly one extension, so a manifest
  // may not name the same component twice — including once as a service and
  // once as an integration.
  .refine((m) => {
    const ids = [
      ...(m.services ?? []).map((s) => s.service),
      ...(m.integrations ?? []).map((i) => i.id),
    ];
    return new Set(ids).size === ids.length;
  }, "component ids must be unique within a manifest")
  // A config or readiness entry that names a component the manifest never
  // declares would be resolved against something outside this bundle.
  .refine((m) => {
    const declared = declaredComponents(m);
    const names = (target: string): boolean => {
      const [kind, id] = target.split(":", 2) as ["service" | "integration", string];
      return kind === "service" ? declared.services.has(id) : declared.integrations.has(id);
    };
    return (
      (m.config ?? []).every((entry) => names(entry.target)) &&
      (m.readiness?.requires ?? []).every(names) &&
      (m.readiness?.integrationHealth === undefined ||
        declared.integrations.has(m.readiness.integrationHealth))
    );
  }, "config and readiness must reference a declared component");

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
