import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrandKind } from "@openmapx/core";
import { BRAND_QID_KEYS } from "@openmapx/core/utils/brandFilter";
import type { BrandArtifact, BrandEntry } from "./types.ts";

const require = createRequire(import.meta.url);

/**
 * `name-suggestion-index`'s package.json declares an `exports` map whose
 * `"dist/*"` key is missing the leading `./` that Node requires for a subpath
 * pattern, so Node treats it as an unrecognized condition and refuses to
 * resolve *any* subpath — including `package.json` itself — via
 * `require.resolve`. Work around it by resolving the package's main entry
 * (which Node does expose, via the `require` condition) and walking up to the
 * directory whose `package.json` actually names this package.
 */
function resolvePackageRoot(packageName: string): string {
  let dir = dirname(require.resolve(packageName));
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (pkg.name === packageName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not locate the root of "${packageName}"`);
    dir = parent;
  }
}

const nsiRoot = resolvePackageRoot("name-suggestion-index");

/**
 * The `*:wikidata` keys, in precedence order — the first one present on an item
 * decides its primary kind. Derived from core's `BRAND_QID_KEYS` rather than
 * restated, so there is exactly one definition of the brand-identity keys.
 */
const QID_KEYS: { key: string; kind: BrandKind }[] = BRAND_QID_KEYS.map((key) => ({
  key,
  kind: key.split(":")[0] as BrandKind,
}));

/** OSM keys that identify what kind of place this is, used for icon selection. */
const PRIMARY_TAG_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "office",
  "healthcare",
  "man_made",
  "highway",
  "aeroway",
];

const MAX_MATCH_NAMES = 24;
const MAX_COUNTRIES = 60;
const MAX_TAG_SETS = 6;

interface NsiItem {
  displayName: string;
  matchNames?: string[];
  locationSet?: { include?: unknown[] };
  tags: Record<string, string>;
}

interface WikidataRecord {
  label?: string;
  description?: string;
  logos?: { wikidata?: string; facebook?: string; twitter?: string };
  officialWebsites?: string[];
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(nsiRoot, relativePath), "utf8")) as T;
}

/** Lowercase, strip diacritics, collapse whitespace. Mirrors the matcher. */
function normalize(input: string): string {
  return input.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * NSI logo URLs come in two shapes: `.../Special:FilePath/<file>` and
 * `.../index.php?title=Special:Redirect/file/<file>&width=<n>` (the latter is
 * about 30% of them). We store the bare Commons filename so the render size
 * is chosen at display time rather than baked into the artifact.
 */
function commonsFilename(logoUrl: string): string | undefined {
  const url = new URL(logoUrl);
  const redirectTitle = url.searchParams.get("title");
  if (redirectTitle) {
    const marker = "Special:Redirect/file/";
    const markerIndex = redirectTitle.indexOf(marker);
    if (markerIndex !== -1) return redirectTitle.slice(markerIndex + marker.length) || undefined;
  }
  const tail = url.pathname.split("/").pop();
  return tail ? decodeURIComponent(tail) : undefined;
}

export function buildArtifact(): BrandArtifact {
  const nsi = readJson<{ nsi: Record<string, { items: NsiItem[] }> }>("dist/json/nsi.min.json").nsi;
  const wikidata = readJson<{ wikidata: Record<string, WikidataRecord> }>(
    "dist/wikidata/wikidata.min.json",
  ).wikidata;
  const nsiVersion = readJson<{ version: string }>("package.json").version;

  interface Accumulator {
    names: Set<string>;
    countries: Set<string>;
    kinds: Set<BrandKind>;
    tagSets: Set<string>;
    itemCount: number;
    fallbackName: string;
  }

  const acc = new Map<string, Accumulator>();

  for (const category of Object.values(nsi)) {
    for (const item of category.items) {
      const hit = QID_KEYS.find(({ key }) => item.tags[key]);
      if (!hit) continue;
      const qid = item.tags[hit.key];

      let entry = acc.get(qid);
      if (!entry) {
        entry = {
          names: new Set(),
          countries: new Set(),
          kinds: new Set(),
          tagSets: new Set(),
          itemCount: 0,
          fallbackName: item.displayName,
        };
        acc.set(qid, entry);
      }

      entry.itemCount += 1;
      entry.kinds.add(hit.kind);
      entry.names.add(item.displayName);
      for (const alias of item.matchNames ?? []) entry.names.add(alias);
      if (item.tags.name) entry.names.add(item.tags.name);

      // locationSet.include mixes ISO codes with GeoJSON objects and region
      // strings; only two/three-letter country codes are useful for ranking.
      for (const region of item.locationSet?.include ?? []) {
        if (typeof region === "string" && region.length <= 3) {
          entry.countries.add(region.toLowerCase());
        }
      }

      for (const key of PRIMARY_TAG_KEYS) {
        const value = item.tags[key];
        if (value) entry.tagSets.add(`${key}=${value}`);
      }
    }
  }

  const brands: BrandEntry[] = [];
  for (const [qid, entry] of acc) {
    const wd = wikidata[qid];
    // Facebook and Twitter logo URLs are dropped here and nowhere else: they
    // would send a viewer's IP to Meta/X on every search result render.
    const logoFile = wd?.logos?.wikidata ? commonsFilename(wd.logos.wikidata) : undefined;

    const brand: BrandEntry = {
      qid,
      name: wd?.label ?? entry.fallbackName,
      kind: [...entry.kinds].sort(),
      matchNames: [...new Set([...entry.names].map(normalize))]
        .filter(Boolean)
        .sort()
        .slice(0, MAX_MATCH_NAMES),
      countries: [...entry.countries].sort().slice(0, MAX_COUNTRIES),
      tagSets: [...entry.tagSets].sort().slice(0, MAX_TAG_SETS),
      itemCount: entry.itemCount,
    };
    if (wd?.description) brand.description = wd.description;
    if (logoFile) brand.logoFile = logoFile;
    const website = wd?.officialWebsites?.[0];
    if (website) brand.website = website;

    brands.push(brand);
  }

  brands.sort((a, b) => a.qid.localeCompare(b.qid));

  return {
    v: 1,
    source: nsiVersion,
    license: "BSD-3-Clause (Name Suggestion Index contributors)",
    brands,
  };
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const artifact = buildArtifact();
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "data", "brands-index.json");
  writeFileSync(outPath, JSON.stringify(artifact));
  console.log(`Wrote ${artifact.brands.length} brands from NSI ${artifact.source} to ${outPath}`);
}
