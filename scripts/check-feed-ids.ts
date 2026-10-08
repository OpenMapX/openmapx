/**
 * Pre-commit guard: every feed/source id in the repo follows the standardized
 * region-first convention (`packages/core/src/feed-id.ts`).
 *
 * Checks:
 *   1. Every `integrations/*\/manifest.json` `dataSources[].sourceId` parses
 *      against `feedIdSchema`.
 *   2. For fuel, `strings/{en,de}.json`
 *      `dataSources` keys and manifest `sourceId`s match in both directions
 *      (a lighter re-assertion of what `check-legal-tables` already covers,
 *      kept here so this gate is self-contained).
 *
 * An integration whose manifest sets `runtimeDataSources: true` has no static
 * sourceIds to check: the host validates each sourceId it supplies at runtime
 * against `feedIdSchema`. This gate names such integrations in its output.
 *
 * Run on demand with `pnpm check-feed-ids`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feedIdSchema } from "@openmapx/core/feed-id";
import type { IntegrationManifest } from "@openmapx/integration-framework";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");
const LOCALES = ["en", "de"] as const;

/** Integrations whose manifest/strings alignment we re-assert here. */
const STRINGS_ALIGNED_INTEGRATIONS = ["fuel"] as const;

interface DiscoveredIntegration {
  id: string;
  manifest: IntegrationManifest;
  dir: string;
}

function discoverIntegrations(baseDir: string): DiscoveredIntegration[] {
  if (!existsSync(baseDir)) return [];
  const out: DiscoveredIntegration[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    const dir = join(baseDir, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: IntegrationManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as IntegrationManifest;
    } catch {
      continue; // invalid JSON is caught by other tooling, not this check
    }
    out.push({ id: manifest.id ?? entry.name, manifest, dir });
  }
  return out;
}

/** Ids of the integrations under `repoRoot` that supply their sources at runtime. */
export function runtimeDataSourceIntegrations(repoRoot: string): string[] {
  return discoverIntegrations(join(repoRoot, "integrations"))
    .filter((it) => it.manifest.runtimeDataSources === true)
    .map((it) => it.id)
    .sort();
}

function loadDataSourceStringKeys(dir: string, locale: string): Set<string> | undefined {
  const path = join(dir, "strings", `${locale}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const content = JSON.parse(readFileSync(path, "utf-8"));
    const ds = content?.dataSources;
    if (ds == null || typeof ds !== "object" || Array.isArray(ds)) return new Set();
    return new Set(Object.keys(ds));
  } catch {
    return new Set();
  }
}

/**
 * Checks #1–2 against the repo at `repoRoot`. Returns a flat list of
 * human-readable violation strings — empty means the gate is clean.
 */
export function collectFeedIdViolations(repoRoot: string): string[] {
  const violations: string[] = [];
  const integrationsDir = join(repoRoot, "integrations");
  const integrations = discoverIntegrations(integrationsDir);
  const byId = new Map(integrations.map((it) => [it.id, it]));

  // Check 1: every manifest sourceId is a valid feed id.
  for (const it of integrations) {
    for (const ds of it.manifest.dataSources ?? []) {
      if (!feedIdSchema.safeParse(ds.sourceId).success) {
        violations.push(
          `${it.id}: manifest.json dataSources sourceId "${ds.sourceId}" is not a valid feed id (feedIdSchema)`,
        );
      }
    }
  }

  // Check 2: strings.dataSources <-> manifest.dataSources sourceId alignment.
  for (const integrationId of STRINGS_ALIGNED_INTEGRATIONS) {
    const it = byId.get(integrationId);
    if (!it) {
      violations.push(`${integrationId}: expected integration not found under integrations/`);
      continue;
    }
    const manifestSourceIds = new Set((it.manifest.dataSources ?? []).map((ds) => ds.sourceId));
    for (const locale of LOCALES) {
      const stringKeys = loadDataSourceStringKeys(it.dir, locale);
      if (!stringKeys) continue; // missing strings/<locale>.json is check-legal-tables' concern
      for (const key of stringKeys) {
        if (!manifestSourceIds.has(key)) {
          violations.push(
            `${integrationId}: strings/${locale}.json dataSources key "${key}" has no matching manifest sourceId`,
          );
        }
      }
      for (const sourceId of manifestSourceIds) {
        if (!stringKeys.has(sourceId)) {
          violations.push(
            `${integrationId}: manifest sourceId "${sourceId}" has no strings/${locale}.json dataSources.${sourceId} entry`,
          );
        }
      }
    }
  }

  return violations;
}

function main(): void {
  const violations = collectFeedIdViolations(REPO_ROOT);

  for (const id of runtimeDataSourceIntegrations(REPO_ROOT)) {
    console.log(
      `ℹ ${id}: runtime data sources — no static sourceIds to check; the host validates ` +
        `each supplied sourceId against feedIdSchema.`,
    );
  }

  if (violations.length === 0) {
    const integrations = discoverIntegrations(INTEGRATIONS_DIR);
    const manifestSourceIdCount = integrations.reduce(
      (sum, it) => sum + (it.manifest.dataSources?.length ?? 0),
      0,
    );
    console.log(
      `✓ feed-id check OK: ${manifestSourceIdCount} manifest sourceIds ` +
        `across ${integrations.length} integrations.`,
    );
    return;
  }

  console.error(`✖ feed-id check: ${violations.length} violation(s).\n`);
  for (const violation of violations) {
    console.error(`  • ${violation}`);
  }
  console.error(
    `\n  See ${relative(REPO_ROOT, join(REPO_ROOT, "packages/core/src/feed-id.ts"))} for the convention.`,
  );
  process.exit(1);
}

// Only run when executed directly (`pnpm check-feed-ids`), not when the repo
// consistency test imports `collectFeedIdViolations` from this module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
