import type { BoundingBox } from "../types/geometry";
import type { PlaceProvenance } from "../types/place";
import type { OsmFilter } from "./osmCategoryFilters";
import { overpassQuery } from "./overpass";
import type { OverpassElement } from "./overpass/types";

export type { OsmFilter } from "./osmCategoryFilters";
export { CATEGORY_FILTERS } from "./osmCategoryFilters";

export const MAX_RESULTS = 50;

export type { BoundingBox };

export interface CategoryPlaceResult {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  isOpen?: boolean;
  provenance?: PlaceProvenance[];
  /** Curated subset of OSM tags surfaced for client-side facet filters (see FILTERABLE_TAG_KEYS). */
  osmTags?: Record<string, string>;
  fuelPrices?: { e5?: number; e10?: number; diesel?: number };
  fuelPricesUpdatedAt?: string;
  fuelAttribution?: { label: string; url: string };
}

function buildCategoryQuery(filters: OsmFilter[], bbox: BoundingBox): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const lines = filters
    .flatMap((f) => [
      `node["${f.key}"="${f.value}"](${bboxStr});`,
      `way["${f.key}"="${f.value}"](${bboxStr});`,
    ])
    .join("\n  ");
  return `[out:json][timeout:15];\n(\n  ${lines}\n);\nout center ${MAX_RESULTS};`;
}

/**
 * Build an Overpass query for a single tag-set. All tag pairs are ANDed onto
 * one element selector (unlike `buildCategoryQuery`, where each filter is an
 * independent OR alternative). Wildcard values (`"*"`) become key-existence
 * predicates (`["key"]`) instead of literal-string matches.
 */
function buildPresetQuery(tags: Record<string, string>, bbox: BoundingBox): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const tagPredicates = Object.entries(tags)
    .map(([key, value]) => (value === "*" ? `["${key}"]` : `["${key}"="${value}"]`))
    .join("");
  if (tagPredicates.length === 0) {
    // Defensive: empty tag-set would otherwise match every node/way in the bbox.
    return `[out:json][timeout:15];\n(\n);\nout center ${MAX_RESULTS};`;
  }
  const lines = [`node${tagPredicates}(${bboxStr});`, `way${tagPredicates}(${bboxStr});`].join(
    "\n  ",
  );
  return `[out:json][timeout:15];\n(\n  ${lines}\n);\nout center ${MAX_RESULTS};`;
}

// OSM tag keys surfaced on results for client-side facet filters (wheelchair,
// the food/drink facets, etc.). Kept to a small allowlist so the payload stays
// lean — add a key here when introducing a new facet filter (see CATEGORY_FACETS).
const FILTERABLE_TAG_KEYS = [
  "wheelchair",
  "outdoor_seating",
  "takeaway",
  "delivery",
  "delivery:partner",
  "delivery:website",
  "website:orders",
  "takeaway:website",
  "contact:website",
  "contact:ubereats",
  "contact:wolt",
  "contact:lieferando",
  "internet_access",
  "diet:vegetarian",
  "diet:vegan",
  "diet:halal",
  "diet:kosher",
  "diet:gluten_free",
  "cuisine",
  "brand",
  "operator",
  "brand:wikidata",
] as const;

function pickFilterableTags(tags: Record<string, string>): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  for (const key of FILTERABLE_TAG_KEYS) {
    const value = tags[key];
    if (value) picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function formatAddress(tags: Record<string, string>): string | undefined {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  if (street && number) return `${street} ${number}`;
  if (street) return street;
  return undefined;
}

function getCategoryValue(tags: Record<string, string>): string | undefined {
  return (
    tags.amenity ??
    tags.tourism ??
    tags.leisure ??
    tags.railway ??
    tags.highway ??
    tags.public_transport ??
    tags.emergency ??
    tags.shop ??
    tags.sport ??
    tags.building ??
    tags.natural ??
    tags.aeroway ??
    tags.healthcare ??
    undefined
  );
}

export function mapOverpassElements(elements: readonly OverpassElement[]): CategoryPlaceResult[] {
  const results: CategoryPlaceResult[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name =
      tags.name ??
      (tags.emergency === "defibrillator" ? "Defibrillator" : undefined) ??
      (tags.amenity === "toilets" ? "Toilet" : undefined) ??
      (tags.amenity === "recycling" ? "Recycling" : undefined) ??
      (tags.amenity === "drinking_water" ? "Drinking Water" : undefined) ??
      (tags.natural === "beach" ? "Beach" : undefined) ??
      (tags.tourism === "viewpoint" ? "Viewpoint" : undefined) ??
      (tags.leisure === "dog_park" ? "Dog Park" : undefined) ??
      (tags.healthcare === "blood_donation" ? "Blood Donation" : undefined) ??
      (tags.aeroway === "aerodrome" ? "Airport" : undefined) ??
      (tags.aeroway === "terminal" ? "Airport Terminal" : undefined);
    if (!name) continue;

    let lat: number;
    let lon: number;
    if (el.type === "node") {
      lat = el.lat;
      lon = el.lon;
    } else if (el.type === "way" && el.center) {
      lat = el.center.lat;
      lon = el.center.lon;
    } else {
      continue;
    }

    results.push({
      id: `osm:${el.type}/${el.id}`,
      name,
      coordinates: [lon, lat],
      category: getCategoryValue(tags),
      address: formatAddress(tags),
      phone: tags.phone ?? tags["contact:phone"] ?? undefined,
      website: tags.website ?? tags["contact:website"] ?? undefined,
      openingHours: tags.opening_hours ?? undefined,
      osmTags: pickFilterableTags(tags),
      provenance: [{ sourceId: "overpass", dataset: "OpenStreetMap" }],
    });
  }
  return results;
}

export async function searchByCategory(
  filters: OsmFilter[],
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  const query = buildCategoryQuery(filters, bbox);
  const data = await overpassQuery(query);
  return mapOverpassElements(data.elements);
}

/**
 * Search Overpass for OSM features whose tags match every entry in the supplied
 * tag-set (AND semantics). Wildcard values (`"*"`) match any value for the key.
 * Used for iD-preset-driven queries; for chip categories that union multiple
 * alternatives, use `searchByCategory` instead.
 */
export async function searchByOsmTags(
  tags: Record<string, string>,
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  const query = buildPresetQuery(tags, bbox);
  const data = await overpassQuery(query);
  return mapOverpassElements(data.elements);
}

/** Escape backslash and double-quote so a literal value can be safely embedded inside `"..."`. */
export function escapeOverpassLiteral(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

function buildAttributePredicates(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) =>
      key === "cuisine"
        ? `["${escapeOverpassLiteral(key)}"~"${escapeOverpassRegex(value)}"]`
        : `["${escapeOverpassLiteral(key)}"="${escapeOverpassLiteral(value)}"]`,
    )
    .join("");
}

export function buildCategoryWithAttributesQuery(
  filters: OsmFilter[],
  attributes: Record<string, string>,
  bbox: BoundingBox,
): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const attrs = buildAttributePredicates(attributes);
  const lines = filters
    .flatMap((f) => [
      `node["${f.key}"="${f.value}"]${attrs}(${bboxStr});`,
      `way["${f.key}"="${f.value}"]${attrs}(${bboxStr});`,
    ])
    .join("\n  ");
  return `[out:json][timeout:15];\n(\n  ${lines}\n);\nout center ${MAX_RESULTS};`;
}

export async function searchByCategoryWithAttributes(
  filters: OsmFilter[],
  attributes: Record<string, string>,
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  const query = buildCategoryWithAttributesQuery(filters, attributes, bbox);
  const data = await overpassQuery(query);
  return mapOverpassElements(data.elements);
}

// POI tag keys a free-text name search is scoped to, so we match named places
// (shops, venues, …) rather than streets, boundaries or address-only nodes.
const TEXT_SEARCH_KEYS = ["amenity", "shop", "tourism", "leisure", "office", "healthcare"] as const;

/**
 * Escape regex metacharacters + the quote so text embeds safely inside `~"..."`.
 * All metacharacters including `|` are escaped so user-supplied strings match
 * literally — callers that need alternation must use their own escaper.
 */
export function escapeOverpassRegex(value: string): string {
  return value.replace(/[\\.*+?()[\]{}^$|"]/g, "\\$&");
}

function buildTextQuery(query: string, bbox: BoundingBox): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const escaped = escapeOverpassRegex(query.trim());
  const lines = TEXT_SEARCH_KEYS.flatMap((key) => [
    `node["name"~"${escaped}",i]["${key}"](${bboxStr});`,
    `way["name"~"${escaped}",i]["${key}"](${bboxStr});`,
  ]).join("\n  ");
  return `[out:json][timeout:25];\n(\n  ${lines}\n);\nout center ${MAX_RESULTS};`;
}

/**
 * Free-text POI search: matches OSM features whose `name` contains `query`
 * (case-insensitive) within the bbox, scoped to {@link TEXT_SEARCH_KEYS}.
 * Returns the same rich shape as {@link searchByCategory} so the results panel
 * and facet filters work identically for text and category searches.
 */
export async function searchByText(
  query: string,
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  if (query.trim().length === 0) return [];
  const data = await overpassQuery(buildTextQuery(query, bbox));
  return mapOverpassElements(data.elements);
}
