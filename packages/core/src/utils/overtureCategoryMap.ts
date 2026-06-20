import type { CategoryId } from "@integrations/poi-search/types";
import mapJson from "./overtureCategoryMap.json" with { type: "json" };

type CategoryMap = Record<string, string[]>;

const categoryMap = mapJson as CategoryMap;

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
