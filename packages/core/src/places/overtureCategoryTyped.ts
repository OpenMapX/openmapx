import type { CategoryId } from "../types/category";
import {
  OVERTURE_COMMERCIAL_CATEGORIES as categories,
  overtureTaxonomyToOpenMapX as categoryForTaxonomy,
  openMapXCategoryToOvertureConcepts as conceptsForCategory,
  type OvertureTaxonomyValues,
} from "./overtureCategoryMap";

export const OVERTURE_COMMERCIAL_CATEGORIES = categories as CategoryId[];

export function openMapXCategoryToOvertureConcepts(category: CategoryId | string): string[] {
  return conceptsForCategory(category);
}

export function overtureTaxonomyToOpenMapX(
  taxonomy: OvertureTaxonomyValues,
): CategoryId | undefined {
  return categoryForTaxonomy(taxonomy) as CategoryId | undefined;
}

export type { OvertureTaxonomyValues };
