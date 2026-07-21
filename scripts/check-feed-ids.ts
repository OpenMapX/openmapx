/**
 * Pre-commit guard: every feed/source id in the repo follows the standardized
 * region-first convention (`packages/core/src/feed-id.ts`) — hand-typed ids
 * are never allowed to drift from what `deriveFeedId(parts)` would produce.
 *
 * Checks:
 *   1. Every `integrations/*\/manifest.json` `dataSources[].sourceId` parses
 *      against `feedIdSchema`.
 *   2. Every `parts: {...}` literal in every `integrations/*\/poi-sources.ts`
 *      (discovered dynamically) parses against `feedIdPartsSchema` — this is
 *      what rejects a hyphen sneaking into a single token (e.g.
 *      `operator: "parkapi-v2"`, which must instead be
 *      `operator: "parkapi", stream: "v2"`) — and its `deriveFeedId(parts)`
 *      output parses against `feedIdSchema`. Extraction is regex-based, so a
 *      per-file independent count cross-check (extracted `parts` objects vs.
 *      `domain:` field occurrences) guards against the extraction silently
 *      going stale (see `countPoiSourceDomainDeclarations`).
 *   3. Each poi-source's `deriveFeedId(parts)` appears as a manifest
 *      `sourceId` in that same integration, so attribution/legal has an
 *      entry for every ingested feed.
 *   4. `deriveFeedId(parts)` is globally unique across all poi-source
 *      integrations — they share the `poi_ingest` Postgres schema.
 *   5. For ev-charging, parking and fuel, `strings/{en,de}.json`
 *      `dataSources` keys and manifest `sourceId`s match in both directions
 *      (a lighter re-assertion of what `check-legal-tables` already covers,
 *      kept here so this gate is self-contained).
 *
 * Run on demand with `pnpm check-feed-ids`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveFeedId,
  type FeedIdParts,
  feedIdPartsSchema,
  feedIdSchema,
} from "@openmapx/core/feed-id";
import type { IntegrationManifest } from "@openmapx/integration-framework";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");
const LOCALES = ["en", "de"] as const;

/** Integrations whose manifest/strings alignment we re-assert here. */
const STRINGS_ALIGNED_INTEGRATIONS = ["ev-charging", "parking", "fuel"] as const;

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

/**
 * Discover every integration under `baseDir` that declares a
 * `poi-sources.ts` file. Dynamic on purpose: a future domain that adds its
 * own `poi-sources.ts` is picked up automatically, with no hardcoded list to
 * remember to update.
 */
function discoverPoiSourceIntegrationIds(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    if (existsSync(join(baseDir, entry.name, "poi-sources.ts"))) {
      out.push(entry.name);
    }
  }
  return out.sort();
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

/** One `parts: {...}` literal extracted from a `poi-sources.ts` file. */
interface ExtractedParts {
  /** 1-based line number the `parts:` literal starts on, for error messages. */
  line: number;
  raw: string;
  parts: Record<string, string>;
}

/**
 * Extract every `parts: { key: "value", ... }` object literal from a
 * `poi-sources.ts` source file. The literals are always flat, single-object,
 * string-valued — no nested braces — so a non-greedy brace match is safe.
 */
function extractPoiSourceParts(source: string): ExtractedParts[] {
  const out: ExtractedParts[] = [];
  const objectRe = /parts:\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((match = objectRe.exec(source))) {
    const raw = match[0];
    const body = match[1] ?? "";
    const parts: Record<string, string> = {};
    const pairRe = /(\w+)\s*:\s*"([^"]*)"/g;
    let pairMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((pairMatch = pairRe.exec(body))) {
      parts[pairMatch[1]] = pairMatch[2];
    }
    const line = source.slice(0, match.index).split("\n").length;
    out.push({ line, raw, parts });
  }
  return out;
}

/**
 * Count top-level `PoiSource` declarations in a `poi-sources.ts` file via a
 * marker independent of the `parts:` literal form: every `PoiSource` has
 * exactly one `domain:` field, regardless of whether its feed id comes from
 * an inline `parts: {...}` object, a spread/const/helper, or a hand-typed
 * `id`. Used as a cross-check so a refactor that changes how `parts` is
 * expressed doesn't silently zero out the extraction below.
 */
function countPoiSourceDomainDeclarations(source: string): number {
  return (source.match(/\bdomain:\s*"/g) ?? []).length;
}

/**
 * Checks #1–5 against the repo at `repoRoot`. Returns a flat list of
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

  // Checks 2–4: poi-source parts, derivation, cross-check against the
  // manifest, and global uniqueness across the shared poi_ingest schema.
  const derivedIds = new Map<string, string>(); // derived id -> "<integration>:<line>"
  const poiSourceIntegrationIds = discoverPoiSourceIntegrationIds(integrationsDir);
  for (const integrationId of poiSourceIntegrationIds) {
    const it = byId.get(integrationId);
    const poiSourcesPath = join(integrationsDir, integrationId, "poi-sources.ts");
    if (!existsSync(poiSourcesPath)) {
      violations.push(`${integrationId}: expected poi-sources.ts not found at ${poiSourcesPath}`);
      continue;
    }
    const source = readFileSync(poiSourcesPath, "utf-8");
    const extracted = extractPoiSourceParts(source);
    const manifestSourceIds = new Set((it?.manifest.dataSources ?? []).map((ds) => ds.sourceId));

    // Independent cross-check: the number of extracted `parts:{...}` objects
    // must equal the number of `domain:` fields (one per declared PoiSource).
    // A mismatch means the regex-based extraction above is stale — e.g. a
    // `parts` literal was refactored into a spread/const/helper (parts count
    // drops below domain count), or a source declares a hand-typed `id`
    // with no `parts` at all (the type-sanctioned escape hatch for globals
    // like `osm` also trips this on purpose: we'd rather force a conscious
    // decision here than silently skip coverage). Either way, fail closed
    // instead of reporting a stale/zero parts count as success.
    const domainCount = countPoiSourceDomainDeclarations(source);
    if (extracted.length !== domainCount) {
      violations.push(
        `${integrationId}/poi-sources.ts: extracted ${extracted.length} parts objects but found ${domainCount} source declarations — ` +
          `parts extraction is stale (poi-sources.ts format may have changed, or a source uses a non-inline/id-only declaration). ` +
          `The feed-id gate cannot validate this file.`,
      );
    }

    for (const { line, parts } of extracted) {
      const where = `${integrationId}/poi-sources.ts:${line}`;
      const partsResult = feedIdPartsSchema.safeParse(parts);
      if (!partsResult.success) {
        const issues = partsResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        violations.push(
          `${where}: parts ${JSON.stringify(parts)} failed feedIdPartsSchema (${issues})`,
        );
        continue;
      }

      const derived = deriveFeedId(partsResult.data as FeedIdParts);
      if (!feedIdSchema.safeParse(derived).success) {
        violations.push(`${where}: deriveFeedId(parts) produced invalid feed id "${derived}"`);
        continue;
      }

      if (!manifestSourceIds.has(derived)) {
        violations.push(
          `${where}: deriveFeedId(parts) = "${derived}" has no matching manifest.json dataSources sourceId in integrations/${integrationId}`,
        );
      }

      const existing = derivedIds.get(derived);
      if (existing) {
        violations.push(
          `${where}: derived feed id "${derived}" collides with ${existing} (poi_ingest ids must be globally unique)`,
        );
      } else {
        derivedIds.set(derived, where);
      }
    }
  }

  // Check 5: strings.dataSources <-> manifest.dataSources sourceId alignment.
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

  if (violations.length === 0) {
    const integrations = discoverIntegrations(INTEGRATIONS_DIR);
    const manifestSourceIdCount = integrations.reduce(
      (sum, it) => sum + (it.manifest.dataSources?.length ?? 0),
      0,
    );
    const poiSourcePartsCount = discoverPoiSourceIntegrationIds(INTEGRATIONS_DIR).reduce(
      (sum, integrationId) => {
        const path = join(INTEGRATIONS_DIR, integrationId, "poi-sources.ts");
        if (!existsSync(path)) return sum;
        return sum + extractPoiSourceParts(readFileSync(path, "utf-8")).length;
      },
      0,
    );
    console.log(
      `✓ feed-id check OK: ${manifestSourceIdCount} manifest sourceIds, ${poiSourcePartsCount} poi-source parts ` +
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
