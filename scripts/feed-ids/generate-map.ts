/**
 * Auto-derives the old->new feed-id migration map.
 *
 * Reads the poi-ingest source declarations and manifests via `node:fs` (this file
 * runs from `packages/cli`'s run-context, which does not depend on the integration
 * packages, so the integration modules cannot be `import`ed — see
 * `scripts/check-data-flows.ts` for the precedent). Writes a DRAFT
 * `scripts/feed-ids/feed-id-map.json`: every poi-ingest source (ev-charging +
 * parking, DB-backed) plus the manifest-only national overlays get a derived
 * `newId`; globals (ocm/osm/opendatasoft) stay bare. `parts.subdivision` is
 * always left `undefined` — a human fills it in during hand-curation.
 *
 * ONE-TIME ARTIFACT: this generator reads the OLD literal `id:`/`stationIdPrefix:`
 * declarations to build the old->new map. Once the migration landed, those
 * declarations were replaced with derived `parts`, so the old ids no longer
 * exist in the tree — re-running this now would emit a degenerate map (globals +
 * manifest-only only, zero poi-ingest entries). The committed `feed-id-map.json`
 * is the finished map; treat it as frozen. Do not re-run against the migrated tree.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertUniqueFeedIds,
  deriveFeedId,
  type FeedIdParts,
  feedIdPartsSchema,
  feedIdSchema,
} from "@openmapx/core/feed-id";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");
const OUTPUT_FILE = join(REPO_ROOT, "scripts", "feed-ids", "feed-id-map.json");

/** Manifest sourceIds that stay bare — global crowdsource/platform, no country/operator split. */
const GLOBALS = new Set(["ocm", "osm", "opendatasoft"]);

/**
 * Human-curated overrides merged onto the auto-derived parts. `deriveParts` gets
 * country + a best-effort operator + stream; the residual that metadata cannot
 * supply is the subdivision (manifests carry no bbox) and a few operator/stream
 * corrections. Each override is shallow-merged over the derived parts, then the
 * `newId` is recomputed, so the map stays fully generated.
 *
 * Subdivisions are ISO 3166-2 codes, verified against each source's `coverage`
 * bbox in its `poi-sources.ts`. Compound operators are re-split into a hyphenless
 * operator + stream (an operator token must match /^[a-z0-9]+$/) while keeping the
 * same resulting `newId`.
 */
const CURATION: Readonly<Record<string, Partial<FeedIdParts>>> = {
  "salzburg-at": { subdivision: "5" },
  "vienna-at": { subdivision: "9" },
  "brussels-be": { subdivision: "bru" },
  "ghent-be": { subdivision: "vlg" },
  "basel-ch": { subdivision: "bs" },
  "bamberg-de": { subdivision: "by" },
  "bielefeld-de": { subdivision: "nw" },
  "braunschweig-de": { subdivision: "ni" },
  "bremen-de": { subdivision: "hb" },
  "duesseldorf-de": { subdivision: "nw" },
  "potsdam-de": { subdivision: "bb" },
  "trier-de": { subdivision: "rp" },
  "nrw-mobidrom-parking": { subdivision: "nw" },
  "nrw-mobidrom-pr": { subdivision: "nw" },
  "copenhagen-dk": { subdivision: "84" },
  "barcelona-es": { subdivision: "ct" },
  "madrid-es": { subdivision: "md" },
  "florence-it": { subdivision: "52" },
  "opendatahub-it": { subdivision: "32" },
  "utmc-newcastle": { subdivision: "eng" },
  "apag-mobidrom": { operator: "apag", stream: "mobidrom" },
  "db-bahnpark": { operator: "db", stream: "bahnpark" },
  "parkapi-v2": { operator: "parkapi", stream: "v2" },
  "parkapi-v3": { operator: "parkapi", stream: "v3" },
  singapore: { operator: "hdb" },
  "opentransportdata-ch-parking": { operator: "otd" },
  "e-control-at": { operator: "econtrol" },
  "prix-carburants-fr": { operator: "prixcarburants" },
};

/** Shallow-merge the curated override (if any) onto the derived parts. */
function applyCuration(oldId: string, parts: FeedIdParts | null): FeedIdParts | null {
  if (!parts) return parts;
  const override = CURATION[oldId];
  return override ? { ...parts, ...override } : parts;
}

/** Integrations whose `declarePoiSources()` back a `poi_ingest` DB table (INVENTORY.md Table A). */
const POI_INGEST_INTEGRATIONS: readonly { integration: string; domain: string }[] = [
  { integration: "ev-charging", domain: "ev-charging" },
  { integration: "parking", domain: "parking" },
];

/** National-overlay manifest sourceIds that migrate (manifest string only — no DB table, Table B). */
const MANIFEST_ONLY: readonly {
  integration: string;
  domain: string;
  oldSourceId: string;
  providerCountry: string;
}[] = [
  { integration: "ev-charging", domain: "ev-charging", oldSourceId: "afdc", providerCountry: "US" },
  {
    integration: "ev-charging",
    domain: "ev-charging",
    oldSourceId: "nobil",
    providerCountry: "NO",
  },
  {
    integration: "ev-charging",
    domain: "ev-charging",
    oldSourceId: "france-irve",
    providerCountry: "FR",
  },
  { integration: "fuel", domain: "fuel", oldSourceId: "tankerkoenig", providerCountry: "DE" },
  { integration: "fuel", domain: "fuel", oldSourceId: "e-control-at", providerCountry: "AT" },
  {
    integration: "fuel",
    domain: "fuel",
    oldSourceId: "prix-carburants-fr",
    providerCountry: "FR",
  },
  { integration: "fuel", domain: "fuel", oldSourceId: "minetur-es", providerCountry: "ES" },
];

export interface MapEntry {
  domain: string;
  oldId: string;
  oldPrefix?: string;
  parts: FeedIdParts | null;
  newId: string | null;
  newPrefix: string | null;
  migrate: boolean;
  tableOld?: string;
  tableNew?: string;
}

interface DeriveInput {
  oldId: string;
  oldPrefix?: string;
  providerCountry: string;
  domain: string;
  global?: boolean;
}

const STREAM_SUFFIXES = ["pr", "truck", "flow"] as const;

/**
 * Country adjectives/names that collapse to nothing so a bare "<country>-<domain>"
 * oldId (e.g. "switzerland-ev", "france-irve") reduces to an empty operator and
 * forces a fallback to the richer source (prefix, or the raw id as a last resort).
 */
const COUNTRY_SYNONYMS: Record<string, readonly string[]> = {
  ch: ["swiss", "switzerland"],
  nl: ["netherlands", "dutch"],
  de: ["germany", "deutschland"],
  gb: ["uk", "britain", "england"],
  us: ["usa", "america"],
  fr: ["france"],
  no: ["norway"],
  be: ["belgium"],
  es: ["spain"],
  it: ["italy"],
  at: ["austria"],
  dk: ["denmark"],
  sg: ["singapore"],
  au: ["australia"],
  lu: ["luxembourg"],
};

function stripColon(s: string): string {
  return s.endsWith(":") ? s.slice(0, -1) : s;
}

/** A trailing `-pr`/`-truck`/`-flow` on the prefix (preferred) or the id. */
function detectStream(oldId: string, oldPrefix?: string): string | undefined {
  const prefixBody = oldPrefix ? stripColon(oldPrefix) : undefined;
  for (const s of STREAM_SUFFIXES) if (prefixBody?.endsWith(`-${s}`)) return s;
  for (const s of STREAM_SUFFIXES) if (oldId.endsWith(`-${s}`)) return s;
  return undefined;
}

function stripLeadingCountryToken(tokens: string[], countryLower: string): string[] {
  if (tokens.length === 0) return tokens;
  const [first, ...rest] = tokens;
  const synonyms = COUNTRY_SYNONYMS[countryLower] ?? [];
  return first === countryLower || synonyms.includes(first) ? rest : tokens;
}

/** Strip a trailing "-<domain>" (e.g. "-ev-charging") or its "-ev" shorthand. */
function stripTrailingDomain(tokens: string[], domain: string): string[] {
  const domainTokens = domain.split("-");
  if (tokens.length >= domainTokens.length) {
    const start = tokens.length - domainTokens.length;
    if (domainTokens.every((t, i) => tokens[start + i] === t)) return tokens.slice(0, start);
  }
  if (tokens[tokens.length - 1] === "ev") return tokens.slice(0, -1);
  return tokens;
}

/**
 * Best-effort operator slug from the stationIdPrefix — usually the closest thing
 * the codebase already has to an operator name (e.g. "swiss-sfoe:" -> "sfoe").
 */
function operatorFromPrefix(
  oldPrefix: string,
  domain: string,
  stream: string | undefined,
  countryLower: string,
): string | null {
  let tokens = stripColon(oldPrefix).split("-").filter(Boolean);
  tokens = stripLeadingCountryToken(tokens, countryLower);
  if (tokens.length > 1 && tokens[tokens.length - 1] === countryLower) tokens = tokens.slice(0, -1);
  tokens = stripTrailingDomain(tokens, domain);
  if (stream && tokens[tokens.length - 1] === stream) tokens = tokens.slice(0, -1);
  return tokens.length ? tokens.join("-") : null;
}

/**
 * Best-effort operator slug from the oldId, used when the prefix carries no
 * operator info of its own (e.g. "nrw-pr:" only encodes region+stream, not the
 * "mobidrom" operator that only appears in the oldId).
 */
function operatorFromId(
  oldId: string,
  domain: string,
  stream: string | undefined,
  countryLower: string,
): string | null {
  let tokens = oldId.split("-").filter(Boolean);
  tokens = stripLeadingCountryToken(tokens, countryLower);
  if (stream) tokens = tokens.filter((t) => t !== stream);
  if (tokens.length > 1 && tokens[tokens.length - 1] === countryLower) tokens = tokens.slice(0, -1);
  tokens = stripTrailingDomain(tokens, domain);
  // A short (<=3 char) leading token left over after country/stream/domain
  // stripping usually reads as a subdivision code (e.g. "nrw"), not the operator.
  if (tokens.length > 1 && tokens[0].length <= 3) tokens = tokens.slice(1);
  return tokens.length ? tokens.join("-") : null;
}

/** The only unit-tested piece: derives {country, subdivision?, operator, stream?}
 * from an old source id/prefix, or `null` for a global that stays bare. */
export function deriveParts(input: DeriveInput): FeedIdParts | null {
  if (input.global) return null;
  const country = input.providerCountry.toLowerCase();
  const stream = detectStream(input.oldId, input.oldPrefix);

  let operator: string | null = null;
  if (input.oldPrefix) {
    const fromPrefix = operatorFromPrefix(input.oldPrefix, input.domain, stream, country);
    if (fromPrefix) {
      const fromId = operatorFromId(input.oldId, input.domain, stream, country);
      // A single short prefix-derived token usually reads as a region/subdivision
      // shorthand (e.g. "nrw"), not an operator — prefer the id-derived slug when
      // it actually disagrees and adds information.
      operator =
        fromId && fromPrefix.length <= 3 && !fromPrefix.includes("-") && fromId !== fromPrefix
          ? fromId
          : fromPrefix;
    }
  }
  if (!operator) operator = operatorFromId(input.oldId, input.domain, stream, country);
  if (!operator) operator = input.oldId; // last-resort fallback, never empty

  return stream ? { country, operator, stream } : { country, operator };
}

interface RawPoiSource {
  oldId: string;
  oldPrefix: string;
  attributionSourceId?: string;
}

/** Static-reads `declarePoiSources()`'s flat array literal via regex — each
 * source block runs from one `id: "..."` up to the next (or EOF). */
function extractPoiSources(fileContent: string): RawPoiSource[] {
  const idRe = /id:\s*"([^"]+)",/g;
  const matches = [...fileContent.matchAll(idRe)];
  const out: RawPoiSource[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end =
      i + 1 < matches.length ? (matches[i + 1].index ?? fileContent.length) : fileContent.length;
    const block = fileContent.slice(start, end);
    const prefixMatch = block.match(/stationIdPrefix:\s*"([^"]+)"/);
    if (!prefixMatch) continue; // defensive: skip anything that isn't a real PoiSource entry
    const attrMatch = block.match(/attributionSourceId:\s*"([^"]+)"/);
    out.push({
      oldId: matches[i][1],
      oldPrefix: prefixMatch[1],
      attributionSourceId: attrMatch?.[1],
    });
  }
  return out;
}

interface ManifestDataSource {
  sourceId?: string;
  providerCountry?: string;
}

function readManifestCountryMap(integration: string): Map<string, string> {
  const manifestPath = join(INTEGRATIONS_DIR, integration, "manifest.json");
  const map = new Map<string, string>();
  if (!existsSync(manifestPath)) return map;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dataSources?: ManifestDataSource[];
  };
  for (const ds of manifest.dataSources ?? []) {
    if (ds.sourceId && ds.providerCountry) map.set(ds.sourceId, ds.providerCountry);
  }
  return map;
}

function tableName(id: string): string {
  return `${id.replace(/-/g, "_")}_static`;
}

function buildPoiIngestEntries(): MapEntry[] {
  const entries: MapEntry[] = [];
  for (const { integration, domain } of POI_INGEST_INTEGRATIONS) {
    const poiSourcesPath = join(INTEGRATIONS_DIR, integration, "poi-sources.ts");
    const countryMap = readManifestCountryMap(integration);
    const raw = extractPoiSources(readFileSync(poiSourcesPath, "utf8"));
    for (const source of raw) {
      const providerCountry = countryMap.get(source.attributionSourceId ?? source.oldId);
      if (!providerCountry) {
        throw new Error(
          `no providerCountry for "${source.oldId}" in ${integration}/manifest.json dataSources`,
        );
      }
      const parts = applyCuration(
        source.oldId,
        deriveParts({
          oldId: source.oldId,
          oldPrefix: source.oldPrefix,
          providerCountry,
          domain,
        }),
      );
      const newId = parts ? deriveFeedId(parts) : source.oldId;
      entries.push({
        domain,
        oldId: source.oldId,
        oldPrefix: source.oldPrefix,
        parts,
        newId,
        newPrefix: `${newId}:`,
        migrate: true,
        tableOld: tableName(source.oldId),
        tableNew: tableName(newId),
      });
    }
  }
  return entries;
}

function buildManifestOnlyEntries(): MapEntry[] {
  return MANIFEST_ONLY.map(({ domain, oldSourceId, providerCountry }) => {
    const parts = applyCuration(
      oldSourceId,
      deriveParts({ oldId: oldSourceId, providerCountry, domain }),
    );
    const newId = parts ? deriveFeedId(parts) : oldSourceId;
    return {
      domain,
      oldId: oldSourceId,
      parts,
      newId,
      newPrefix: `${newId}:`,
      migrate: true,
    };
  });
}

/** Every GLOBALS sourceId actually declared in a poi-ingest integration's manifest
 * (INVENTORY.md Table C: ev-charging ocm/osm/opendatasoft, parking osm). */
function buildGlobalEntries(): MapEntry[] {
  const entries: MapEntry[] = [];
  for (const { integration, domain } of POI_INGEST_INTEGRATIONS) {
    const countryMap = readManifestCountryMap(integration);
    for (const sourceId of countryMap.keys()) {
      if (!GLOBALS.has(sourceId)) continue;
      entries.push({
        domain,
        oldId: sourceId,
        parts: null,
        newId: sourceId,
        newPrefix: null,
        migrate: false,
      });
    }
  }
  return entries;
}

export function buildMapEntries(): MapEntry[] {
  const entries = [
    ...buildPoiIngestEntries(),
    ...buildManifestOnlyEntries(),
    ...buildGlobalEntries(),
  ];
  entries.sort(
    (a, b) => a.domain.localeCompare(b.domain) || (a.newId ?? "").localeCompare(b.newId ?? ""),
  );
  return entries;
}

function generate(): MapEntry[] {
  const entries = buildMapEntries();
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.length} entries to ${OUTPUT_FILE}`);
  return entries;
}

function verify(entries: MapEntry[]): void {
  const migrating = entries.filter((e) => e.migrate);
  const globals = entries.filter((e) => !e.migrate);
  const errors: string[] = [];

  for (const entry of migrating) {
    if (!entry.newId || !feedIdSchema.safeParse(entry.newId).success) {
      errors.push(`invalid newId "${entry.newId}" for oldId "${entry.oldId}"`);
    }
    if (!entry.parts?.operator) {
      errors.push(`missing parts.operator for oldId "${entry.oldId}"`);
    }
    if (entry.parts && !feedIdPartsSchema.safeParse(entry.parts).success) {
      errors.push(
        `invalid parts tokens for oldId "${entry.oldId}": ${JSON.stringify(entry.parts)}`,
      );
    }
  }

  try {
    assertUniqueFeedIds(migrating.map((e) => e.newId).filter((id): id is string => Boolean(id)));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const allOldIds = new Set(entries.map((e) => e.oldId));
  for (const key of Object.keys(CURATION)) {
    if (!allOldIds.has(key)) {
      errors.push(`CURATION key "${key}" matches no source (orphaned override)`);
    }
  }

  console.log(
    `${migrating.length} sources OK, ${globals.length} globals skipped, ${errors.length} errors`,
  );
  if (errors.length > 0) {
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }
}

function main(): void {
  const entries = generate();
  if (process.argv.includes("--verify")) verify(entries);
}

// Only run the generator when executed directly (CLI), so importing this module
// for `deriveParts` (the unit-tested pure helper) in tests is side-effect-free.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
