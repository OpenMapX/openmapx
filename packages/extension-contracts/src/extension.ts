import z from "zod/v4";
import { checkCapabilityName } from "./capabilities";
import { componentIdSchema, isComponentId } from "./identifiers";
import { platformVersionSchema } from "./platform";
import { semverSchema } from "./semver";
import type { ManifestValidationResult } from "./service";

export { compareSemver, isSemver, semverSchema } from "./semver";

// `extension.json` — the Extension *bundle* primitive. One versioned, pinned,
// atomically-installed unit that ties together N integrations (in-process,
// `.tar.gz` artifacts) and N services (containers, git repos) plus the config
// they share. The bundle never re-packages the parts — it points
// at the authoritative integration artifact (sha256-pinned) and service repo
// (git ref-pinned). See "Bundle it as an extension" in
// docs/docs/developer/building-an-external-extension.md.

// Git tag or commit SHA.
const REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;
// `service:<id>` | `integration:<id>` — the component a config value targets.
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
  // Registered and reviewed with the bundle but left unselected at install, so
  // the admin opts into it later.
  optional: z.boolean().optional(),
});

const integrationComponentSchema = z.object({
  // Prebuilt `.tar.gz` artifact (immutable). HTTPS only.
  artifact: extensionLocatorSchema,
  // Mandatory content pin, verified before extraction.
  sha256: z.string().regex(SHA256_REGEX, "must be a 64-char hex sha256"),
  // The integration id (manifest id) this artifact installs.
  id: componentIdSchema,
});

/** The grammar of integration setting keys, shared by extension-level keys. */
export const EXTENSION_CONFIG_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/;
export const EXTENSION_CONFIG_KEY_MAX_LENGTH = 64;
/**
 * A generated value is this many random bytes written as lower-case hexadecimal,
 * the form `openssl rand -hex 32` produces for service secret keys.
 */
export const GENERATED_SECRET_BYTES = 32;

const SERVICE_TARGET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// A changelog is a link shown to the admin and never fetched, so unlike a
// locator it may carry the query and fragment release pages use.
const httpsLinkSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "must be an https URL without credentials");

// A value bound to a capability reaches the platform services that consume it
// together with the endpoint, so it is a credential.
const configTargetSchema = z.union([
  z.strictObject({ component: componentTargetSchema, key: z.string().min(1).max(64) }),
  z.strictObject({ capability: z.string().min(1).max(128) }),
]);

const configEntrySchema = z.strictObject({
  key: z
    .string()
    .max(EXTENSION_CONFIG_KEY_MAX_LENGTH)
    .regex(EXTENSION_CONFIG_KEY_PATTERN, "extension config keys must be lowerCamel"),
  targets: z.array(configTargetSchema).min(1).max(16),
  secret: z.boolean().optional(),
  generated: z.boolean().optional(),
  default: z.string().max(4096).optional(),
});

export type ExtensionConfigEntry = z.infer<typeof configEntrySchema>;
export type ExtensionConfigTarget = z.infer<typeof configTargetSchema>;

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
    webPlatform: platformVersionSchema.optional(),
    prerelease: z.boolean().optional(),
    changelog: httpsLinkSchema.optional(),
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

function configIssues(m: {
  services?: Array<{ service: string }>;
  integrations?: Array<{ id: string }>;
  config?: ExtensionConfigEntry[];
}): string[] {
  const config = m.config ?? [];
  const declared = declaredComponents(m);
  const issues = new Set<string>();
  const keys = new Set<string>();
  const componentSettings = new Set<string>();
  const capabilities = new Set<string>();
  for (const entry of config) {
    if (keys.has(entry.key)) issues.add("config keys must be unique");
    keys.add(entry.key);
    if (entry.generated === true && entry.secret !== true) {
      issues.add("a generated config value is a secret");
    }
    if (entry.default !== undefined && entry.secret === true) {
      issues.add("a secret config value has no default");
    }
    for (const target of entry.targets) {
      if ("capability" in target) {
        if (!checkCapabilityName(target.capability, "capability").ok) {
          issues.add("config capability targets name a well-known or <vendor>/<name> capability");
        }
        if (capabilities.has(target.capability)) {
          issues.add("a capability may receive one config value");
        }
        capabilities.add(target.capability);
        if (entry.secret !== true)
          issues.add("a config value delivered to a capability is a secret");
        continue;
      }
      const separator = target.component.indexOf(":");
      const kind = target.component.slice(0, separator);
      const id = target.component.slice(separator + 1);
      const isService = kind === "service";
      if (!(isService ? declared.services : declared.integrations).has(id)) {
        issues.add("config must reference a declared component");
      }
      if (
        !(isService ? SERVICE_TARGET_KEY_PATTERN : EXTENSION_CONFIG_KEY_PATTERN).test(target.key)
      ) {
        issues.add("config target keys follow their component's key style");
      }
      const setting = `${target.component}\u0000${target.key}`;
      if (componentSettings.has(setting)) {
        issues.add("a component setting may receive one config value");
      }
      componentSettings.add(setting);
    }
  }
  return [...issues];
}

export const extensionManifestSchema = z
  .object({
    id: componentIdSchema,
    name: z.string().min(1),
    version: semverSchema,
    // Minimum PLATFORM_VERSION (checked at install via satisfiesPlatformVersion).
    platform: platformVersionSchema,
    webPlatform: platformVersionSchema.optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().url().optional(),
    // Preferred over the catalogue entry's changelog when both exist.
    changelog: httpsLinkSchema.optional(),

    services: z.array(serviceComponentSchema).optional(),
    integrations: z.array(integrationComponentSchema).optional(),

    config: z.array(configEntrySchema).max(64).optional(),
  })
  .strict()
  .refine(
    (m) =>
      (m.services ?? []).some((s) => s.optional !== true) || (m.integrations?.length ?? 0) >= 1,
    "an extension must declare at least one component that is not an optional service",
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
  .superRefine((m, ctx) => {
    for (const message of configIssues(m)) {
      ctx.addIssue({ code: "custom", path: ["config"], message });
    }
  });

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
