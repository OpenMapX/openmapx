import type { CategoryId } from "@integrations/poi-search/types";
import mapJson from "./overtureCategoryMap.json" with { type: "json" };

type CategoryMap = Record<string, string[]>;

const categoryMap = mapJson as CategoryMap;

/**
 * OpenMapX CategoryIds that have Overture Places equivalents — commercial
 * categories where Overture provides meaningful dense coverage. Excludes
 * OSM-only categories (drinking_water, viewpoints, AEDs, bicycle_parkings,
 * playgrounds, etc.) which have no Overture analog.
 */
export const OVERTURE_COMMERCIAL_CATEGORIES: CategoryId[] = [
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
];

/**
 * Reverse index: Overture taxonomy leaf → OpenMapX CategoryId.
 * Built once at module load from the JSON source of truth.
 */
const overtureLeafToCategory = new Map<string, string>(
  Object.entries(categoryMap).flatMap(([catId, leaves]) =>
    leaves.map((leaf) => [leaf, catId] as [string, string]),
  ),
);

/**
 * Maps an Overture `basic_category` or taxonomy leaf to an OpenMapX
 * `CategoryId`. Returns `undefined` for unknown or OSM-only categories
 * (drinking_water, viewpoints, AEDs, etc.) that have no Overture equivalent.
 */
export function overtureCategoryToOpenMapX(leaf: string): CategoryId | undefined {
  return overtureLeafToCategory.get(leaf) as CategoryId | undefined;
}

/**
 * Maps an OpenMapX `CategoryId` to the Overture taxonomy leaves that
 * correspond to it. Returns an empty array for OSM-only categories
 * (drinking_water, viewpoints, AEDs) that carry no Overture equivalent.
 */
export function openMapXCategoryToOverture(category: CategoryId | string): string[] {
  return categoryMap[category] ?? [];
}

/**
 * Returns the Overture category leaf strings for a given OpenMapX CategoryId.
 * Equivalent to `openMapXCategoryToOverture` but signals intent: the result
 * is used to filter Overture Places rows by their taxonomy leaves.
 * Returns an empty array for OSM-only categories.
 */
export function openmapxCategoryToOvertureLeaves(category: CategoryId | string): string[] {
  return categoryMap[category] ?? [];
}
