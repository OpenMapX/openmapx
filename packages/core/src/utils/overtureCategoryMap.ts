import mapJson from "./overtureCategoryMap.json" with { type: "json" };

// overtureCategoryMap.json bridges Overture's ~2k place categories to OpenMapX
// category ids by composing the cbeddow/overture2osm dictionary (Overture
// category → OSM tags) with this repo's OSM-tag → CategoryId filters, then
// merging the hand-curated synonym leaves on top. Regenerate when either the
// Overture taxonomy or CATEGORY_FILTERS changes.
type CategoryMap = Record<string, string[]>;

const categoryMap = mapJson as CategoryMap;

/**
 * OpenMapX category ids the Overture Places provider fans out to — commercial
 * categories where Overture provides meaningful dense coverage. This is a
 * curated subset of the full `overtureCategoryMap.json`: the JSON also carries
 * leaves for infra/civic categories (transit, parks, schools, churches, …) so
 * the ingest's `openmapx_category` backfill and the conflation category gate
 * cover them, but the provider does NOT search those (OSM is the better source).
 * Excludes OSM-only micro-features (drinking_water, viewpoints, AEDs, toilets,
 * recycling) which have no meaningful Overture analog.
 */
export const OVERTURE_COMMERCIAL_CATEGORIES: string[] = [
  "restaurants",
  "cafes",
  "bars",
  "hotels",
  "supermarkets",
  "banks",
  "fuel",
  "shopping_malls",
  "bookstores",
  "pharmacies",
  "bakeries",
  "nightlife",
  "gyms",
  "hairdressers",
  "laundromats",
  "opticians",
  "car_rental",
  "car_repair",
  "veterinarians",
  "markets",
  "cinemas",
  "doctors",
  "dentists",
  "hospitals",
  "museums",
];

/**
 * Reverse index: Overture taxonomy leaf → OpenMapX category id.
 * Built once at module load from the JSON source of truth.
 */
const overtureLeafToCategory = new Map<string, string>(
  Object.entries(categoryMap).flatMap(([catId, leaves]) =>
    leaves.map((leaf) => [leaf, catId] as [string, string]),
  ),
);

/**
 * Maps an Overture `basic_category` or taxonomy leaf to an OpenMapX category
 * id string. Returns `undefined` for unknown or OSM-only categories
 * (drinking_water, viewpoints, AEDs, etc.) that have no Overture equivalent.
 */
export function overtureCategoryToOpenMapX(leaf: string): string | undefined {
  return overtureLeafToCategory.get(leaf);
}

/**
 * Maps an OpenMapX category id to the Overture taxonomy leaves that
 * correspond to it. Returns an empty array for OSM-only categories
 * (drinking_water, viewpoints, AEDs) that carry no Overture equivalent.
 */
export function openMapXCategoryToOverture(category: string): string[] {
  return categoryMap[category] ?? [];
}

/**
 * Returns the Overture category leaf strings for a given OpenMapX category id.
 * Equivalent to `openMapXCategoryToOverture` but signals intent: the result
 * is used to filter Overture Places rows by their taxonomy leaves.
 * Returns an empty array for OSM-only categories.
 */
export function openmapxCategoryToOvertureLeaves(category: string): string[] {
  return categoryMap[category] ?? [];
}
