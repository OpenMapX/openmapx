import type { CategoryId } from "../types/category";
import {
  OVERTURE_COMMERCIAL_CATEGORIES as _OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOverture as _openMapXCategoryToOverture,
  openmapxCategoryToOvertureLeaves as _openmapxCategoryToOvertureLeaves,
  overtureCategoryToOpenMapX as _overtureCategoryToOpenMapX,
} from "./overtureCategoryMap";

/**
 * OpenMapX CategoryIds that have Overture Places equivalents.
 * Typed wrapper over the pure string[] exported from overtureCategoryMap.
 */
export const OVERTURE_COMMERCIAL_CATEGORIES: CategoryId[] =
  _OVERTURE_COMMERCIAL_CATEGORIES as CategoryId[];

/**
 * Maps an Overture `basic_category` or taxonomy leaf to an OpenMapX
 * `CategoryId`. Returns `undefined` for unknown or OSM-only categories.
 */
export function overtureCategoryToOpenMapX(leaf: string): CategoryId | undefined {
  return _overtureCategoryToOpenMapX(leaf) as CategoryId | undefined;
}

/**
 * Maps an OpenMapX `CategoryId` to the Overture taxonomy leaves that
 * correspond to it. Returns an empty array for OSM-only categories.
 */
export function openMapXCategoryToOverture(category: CategoryId | string): string[] {
  return _openMapXCategoryToOverture(category);
}

/**
 * Returns the Overture category leaf strings for a given OpenMapX CategoryId.
 * Equivalent to `openMapXCategoryToOverture` but signals intent: the result
 * is used to filter Overture Places rows by their taxonomy leaves.
 */
export function openmapxCategoryToOvertureLeaves(category: CategoryId | string): string[] {
  return _openmapxCategoryToOvertureLeaves(category);
}
