export type SearchTermKind =
  | "authoritative_code"
  | "explicit_reference"
  | "explicit_alias"
  | "generated_acronym";

export interface SearchTerm {
  normalizedTerm: string;
  displayValue: string;
  kind: SearchTermKind;
  namespace: string | null;
}

export type OsmTags = Record<string, string>;

const ALIAS_KEYS = ["short_name", "alt_name", "official_name", "loc_name"] as const;
const CODE_KEYS = [
  "iata",
  "icao",
  "faa",
  "gps_code",
  "local_code",
  "ref:iata",
  "ref:icao",
  "ref:faa",
  "uic_ref",
  "ref:IFOPT",
  "railway:ref",
  "ref:crs",
  "ref:amtrak",
] as const;
const ADMIN_PLACES = new Set([
  "country",
  "state",
  "region",
  "county",
  "city",
  "town",
  "village",
  "borough",
  "suburb",
  "quarter",
  "neighbourhood",
  "island",
]);
const AEROWAY = new Set(["aerodrome", "terminal", "heliport"]);
const RAILWAY = new Set(["station", "halt", "tram_stop"]);
const NATURAL = new Set(["peak", "volcano", "cave_entrance", "bay", "cape", "spring"]);
const MAN_MADE = new Set(["lighthouse", "tower", "observatory"]);
const ACRONYM_AMENITIES = new Set([
  "school",
  "college",
  "university",
  "hospital",
  "clinic",
  "townhall",
  "courthouse",
  "embassy",
  "police",
  "fire_station",
  "arts_centre",
  "theatre",
]);
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "am",
  "auf",
  "bei",
  "das",
  "der",
  "die",
  "für",
  "fur",
  "im",
  "und",
  "vom",
  "von",
  "zu",
  "zum",
  "zur",
]);

export function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function splitValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasAllowlistedTerm(tags: OsmTags): boolean {
  return [...ALIAS_KEYS, ...CODE_KEYS].some((key) => splitValues(tags[key]).length > 0);
}

function permitsGenericRef(tags: OsmTags): boolean {
  return (
    ADMIN_PLACES.has(tags.place ?? "") ||
    AEROWAY.has(tags.aeroway ?? "") ||
    RAILWAY.has(tags.railway ?? "") ||
    tags.public_transport === "station"
  );
}

export function isSearchableFeature(tags: OsmTags): boolean {
  if (!tags.name?.trim()) return false;
  if (hasAllowlistedTerm(tags)) return true;
  if (
    tags.place ||
    tags.amenity ||
    tags.shop ||
    tags.tourism ||
    tags.leisure ||
    tags.historic ||
    tags.healthcare ||
    tags.office ||
    tags.craft
  ) {
    return true;
  }
  return (
    AEROWAY.has(tags.aeroway ?? "") ||
    RAILWAY.has(tags.railway ?? "") ||
    tags.public_transport === "station" ||
    NATURAL.has(tags.natural ?? "") ||
    MAN_MADE.has(tags.man_made ?? "")
  );
}

function permitsGeneratedAcronym(tags: OsmTags): boolean {
  return (
    ACRONYM_AMENITIES.has(tags.amenity ?? "") ||
    Boolean(tags.healthcare) ||
    tags.office === "government" ||
    tags.tourism === "museum" ||
    tags.tourism === "gallery" ||
    tags.leisure === "stadium" ||
    AEROWAY.has(tags.aeroway ?? "") ||
    RAILWAY.has(tags.railway ?? "") ||
    tags.public_transport === "station" ||
    ADMIN_PLACES.has(tags.place ?? "") ||
    Boolean(tags.wikidata || tags.wikipedia || tags.short_name)
  );
}

export function generateAcronym(name: string, tags: OsmTags): string | null {
  if (!permitsGeneratedAcronym(tags)) return null;
  const preserveEnglishOf = tags.tourism === "museum" || tags.tourism === "gallery";
  const words = name
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .match(/[\p{Letter}\p{Number}]+/gu)
    ?.filter((word) => {
      const normalized = word.toLocaleLowerCase("und");
      return !STOPWORDS.has(normalized) || (preserveEnglishOf && normalized === "of");
    });
  if (!words || words.length < 2) return null;
  const acronym = words
    .map((word) => Array.from(word)[0])
    .join("")
    .toLocaleUpperCase("und");
  return /^[\p{Letter}\p{Number}]{2,8}$/u.test(acronym) ? acronym : null;
}

export function extractTerms(tags: OsmTags): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  const add = (displayValue: string, kind: SearchTermKind, namespace: string | null): void => {
    const normalizedTerm = normalizeSearchTerm(displayValue);
    if (!normalizedTerm) return;
    const key = `${kind}:${namespace ?? ""}:${normalizedTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ normalizedTerm, displayValue, kind, namespace });
  };

  for (const key of ALIAS_KEYS) {
    for (const value of splitValues(tags[key])) add(value, "explicit_alias", key);
  }
  for (const key of CODE_KEYS) {
    for (const value of splitValues(tags[key])) add(value, "authoritative_code", key);
  }
  if (permitsGenericRef(tags)) {
    for (const value of splitValues(tags.ref)) add(value, "explicit_reference", "ref");
  }

  const acronym = generateAcronym(tags.name ?? "", tags);
  if (acronym) {
    const explicitValues = [
      tags.name,
      ...ALIAS_KEYS.map((key) => tags[key]),
      ...CODE_KEYS.map((key) => tags[key]),
    ]
      .flatMap(splitValues)
      .map(normalizeSearchTerm);
    if (!explicitValues.includes(normalizeSearchTerm(acronym))) {
      add(acronym, "generated_acronym", null);
    }
  }
  return terms;
}

export function deriveImportance(tags: OsmTags): number {
  const isLargeAirport = tags.aeroway === "aerodrome" && Boolean(tags.iata || tags.icao);
  const base =
    ["country", "state", "city"].includes(tags.place ?? "") ||
    tags.capital === "yes" ||
    isLargeAirport
      ? 0.9
      : tags.amenity === "university" ||
          tags.amenity === "hospital" ||
          tags.office === "government" ||
          ["museum", "gallery"].includes(tags.tourism ?? "") ||
          tags.leisure === "stadium" ||
          RAILWAY.has(tags.railway ?? "") ||
          tags.public_transport === "station"
        ? 0.7
        : 0.5;
  return Math.min(1, base + (tags.wikidata || tags.wikipedia ? 0.1 : 0));
}

export function deriveCategory(tags: OsmTags): string | null {
  for (const key of [
    "place",
    "amenity",
    "shop",
    "tourism",
    "leisure",
    "historic",
    "healthcare",
    "office",
    "craft",
    "aeroway",
    "railway",
    "public_transport",
    "natural",
    "man_made",
  ]) {
    if (tags[key]) return `${key}/${tags[key]}`;
  }
  return null;
}
