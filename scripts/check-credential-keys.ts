/**
 * Pre-commit guard: for the embedded-provider integrations that aggregate
 * multiple third-party data sources behind one integration id, every
 * credential `configSchema` key must be an exact `<sourceId>-<field>`
 * composition — never a bare camelCase key, never a hand-typed variant that
 * merely starts with a declared sourceId.
 *
 * Checks (for each of `CREDENTIAL_KEYED_INTEGRATIONS`):
 *   1. Every `configSchema.properties` key flagged `x-openmapx-secret: true`
 *      matches `/^[a-z0-9]+(-[a-z0-9]+)*$/`.
 *   2. That key decomposes as `${sourceId}-${field}` for some sourceId the
 *      integration's own `manifest.json` `dataSources[]` declares and some
 *      field in `CREDENTIAL_FIELDS` — checked by exact composition (`key ===
 *      sourceId + "-" + field`), not `startsWith`, so a sourceId that is
 *      itself a hyphenated prefix of another (e.g. `dot-ga` vs a hypothetical
 *      `dot-g`) can never be mis-attributed.
 *   3. Every `ctx.config["<literal>"]` / `ctx.config.<identifier>` access in
 *      that integration's own `.ts` files reads a key its `configSchema`
 *      actually declares. `ctx.config` is typed `Record<string, unknown>`
 *      (an unchecked string index), so renaming a manifest key without
 *      updating the accessor passes `tsc` silently — this check is the only
 *      thing that catches that drift.
 *
 * All other integrations are exempt: single-provider integrations whose id
 * already names the provider legitimately keep bare camelCase keys (e.g.
 * `apiKey`, `accessToken`) and are never inspected by this gate.
 *
 * Run on demand with `pnpm check-credential-keys`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationManifest } from "@openmapx/integration-framework";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");

/**
 * The embedded-provider integrations this gate governs. Each aggregates
 * several third-party data sources behind one integration id, so its
 * credential keys must disambiguate which source they belong to.
 */
export const CREDENTIAL_KEYED_INTEGRATIONS = [
  "ev-charging",
  "fuel",
  "parking",
  "scooter-sharing",
  "bike-sharing",
  "webcam",
] as const;

/** Allowed `<field>` suffixes for a credential key, per the naming convention. */
export const CREDENTIAL_FIELDS = [
  "api-key",
  "client-id",
  "client-secret",
  "username",
  "password",
  "access-token",
] as const;

export const KEY_FORMAT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface LoadedManifest {
  id: string;
  manifest: IntegrationManifest;
  path: string;
}

export function loadManifest(
  integrationId: string,
  integrationsDir = INTEGRATIONS_DIR,
): LoadedManifest | undefined {
  const dir = join(integrationsDir, integrationId);
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf-8")) as IntegrationManifest;
    return { id: manifest.id ?? integrationId, manifest, path };
  } catch {
    return undefined; // invalid JSON is caught by other tooling, not this check
  }
}

/** Credential (`x-openmapx-secret: true`) configSchema property keys, in declaration order. */
export function credentialKeysOf(manifest: IntegrationManifest): string[] {
  const properties = manifest.configSchema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties)
    .filter(
      ([, def]) => def != null && typeof def === "object" && def["x-openmapx-secret"] === true,
    )
    .map(([key]) => key);
}

/**
 * Checks a single credential key against the integration's declared
 * sourceIds. Returns a human-readable violation string, or `undefined` when
 * the key is valid.
 */
export function checkCredentialKey(
  integrationId: string,
  key: string,
  sourceIds: Set<string>,
): string | undefined {
  if (!KEY_FORMAT_RE.test(key)) {
    return (
      `${integrationId}: configSchema credential key "${key}" does not match the required ` +
      `format ${KEY_FORMAT_RE.source} (lowercase, hyphen-separated)`
    );
  }

  const matches = [...sourceIds].some((sourceId) =>
    CREDENTIAL_FIELDS.some((field) => key === `${sourceId}-${field}`),
  );
  if (!matches) {
    return (
      `${integrationId}: configSchema credential key "${key}" is not a valid ` +
      `"<sourceId>-<field>" composition — expected one of this integration's declared ` +
      `dataSources sourceIds (${[...sourceIds].join(", ") || "none declared"}) followed by ` +
      `"-" and one of [${CREDENTIAL_FIELDS.join(", ")}]`
    );
  }

  return undefined;
}

/**
 * All `configSchema.properties` keys, secret or not — an accessor reading a
 * non-secret key (e.g. `enabled`) is just as much a manifest/accessor
 * mismatch as one reading a secret.
 */
export function allConfigKeysOf(manifest: IntegrationManifest): Set<string> {
  const properties = manifest.configSchema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties || typeof properties !== "object") return new Set();
  return new Set(Object.keys(properties));
}

/**
 * Config keys that some integration legitimately reads off `ctx.config` even
 * though the host injects them rather than the integration's own
 * `configSchema` declaring them (for example, a shared `redis`/`endpoint`
 * handle). None of the six
 * `CREDENTIAL_KEYED_INTEGRATIONS` currently do this — this set exists so a
 * future one that legitimately needs to can be exempted here, with a comment,
 * instead of the check being weakened.
 */
export const CONFIG_ACCESSOR_EXEMPTIONS: ReadonlySet<string> = new Set([]);

const CONFIG_ACCESSOR_RE = /\bctx\.config(?:\[\s*(['"])([^'"]+)\1\s*\]|\.([A-Za-z_$][\w$]*))/g;

/** `ctx.config["<literal>"]` / `ctx.config.<identifier>` accesses found in one file's source. */
export function findConfigAccessors(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(CONFIG_ACCESSOR_RE)) {
    const key = match[2] ?? match[3];
    if (key) keys.push(key);
  }
  return keys;
}

/** Recursively lists `.ts` files under `dir`, skipping tests and non-source dirs. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Check #3: every `ctx.config` accessor in a governed integration's own
 * source files reads a key its own `configSchema` declares (or an explicitly
 * named exemption). Catches a manifest key rename that forgot to update the
 * `index.ts` (or other) accessor — `ctx.config` is an unchecked string index,
 * so `tsc` cannot catch this.
 */
export function collectConfigAccessorViolations(repoRoot: string): string[] {
  const violations: string[] = [];
  const integrationsDir = join(repoRoot, "integrations");

  for (const integrationId of CREDENTIAL_KEYED_INTEGRATIONS) {
    const loaded = loadManifest(integrationId, integrationsDir);
    if (!loaded) continue; // already reported by collectCredentialKeyViolations

    const declaredKeys = allConfigKeysOf(loaded.manifest);
    const dir = join(integrationsDir, integrationId);
    for (const file of listSourceFiles(dir)) {
      const source = readFileSync(file, "utf-8");
      for (const key of findConfigAccessors(source)) {
        if (declaredKeys.has(key) || CONFIG_ACCESSOR_EXEMPTIONS.has(key)) continue;
        violations.push(
          `${integrationId}: ${relative(repoRoot, file)} reads ctx.config["${key}"], which is ` +
            `not declared in ${integrationId}'s configSchema (and is not in ` +
            `CONFIG_ACCESSOR_EXEMPTIONS) — likely a stale accessor after a key rename`,
        );
      }
    }
  }

  return violations;
}

/**
 * Checks #1–3 against the repo at `repoRoot`. Returns a flat list of
 * human-readable violation strings — empty means the gate is clean.
 */
export function collectCredentialKeyViolations(repoRoot: string): string[] {
  const violations: string[] = [];
  const integrationsDir = join(repoRoot, "integrations");

  for (const integrationId of CREDENTIAL_KEYED_INTEGRATIONS) {
    const path = join(integrationsDir, integrationId, "manifest.json");
    const loaded = loadManifest(integrationId, integrationsDir);
    if (!loaded) {
      violations.push(`${integrationId}: expected manifest.json not found at ${path}`);
      continue;
    }

    const sourceIds = new Set((loaded.manifest.dataSources ?? []).map((ds) => ds.sourceId));
    for (const key of credentialKeysOf(loaded.manifest)) {
      const violation = checkCredentialKey(integrationId, key, sourceIds);
      if (violation) violations.push(violation);
    }
  }

  violations.push(...collectConfigAccessorViolations(repoRoot));

  return violations;
}

function main(): void {
  const violations = collectCredentialKeyViolations(REPO_ROOT);

  if (violations.length === 0) {
    const credentialKeyCount = CREDENTIAL_KEYED_INTEGRATIONS.reduce((sum, integrationId) => {
      const loaded = loadManifest(integrationId);
      return sum + (loaded ? credentialKeysOf(loaded.manifest).length : 0);
    }, 0);
    console.log(
      `✓ credential-key check OK: ${credentialKeyCount} credential keys across ` +
        `${CREDENTIAL_KEYED_INTEGRATIONS.length} embedded-provider integrations.`,
    );
    return;
  }

  console.error(`✖ credential-key check: ${violations.length} violation(s).\n`);
  for (const violation of violations) {
    console.error(`  • ${violation}`);
  }
  console.error(
    `\n  Credential configSchema keys must be "<sourceId>-<field>", where <sourceId> is a ` +
      `dataSources[].sourceId declared by that same integration's manifest.json and <field> is ` +
      `one of [${CREDENTIAL_FIELDS.join(", ")}].`,
  );
  process.exit(1);
}

// Only run when executed directly (`pnpm check-credential-keys`), not when the repo
// consistency test imports `collectCredentialKeyViolations` from this module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
