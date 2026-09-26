import { useMemo } from "react";
import { useCategoryFacetStore } from "../stores/categoryFacetStore";
import { useOpeningHoursStore } from "../stores/openingHoursStore";
import type { CategoryPlace } from "../types/category";
import { applyFacetFilters } from "../utils/categoryFacets";
import { applyHoursFilter } from "../utils/categoryFilter";
import { presentCategoryOpeningHours } from "../utils/openingHoursClient";
import { useOpeningHoursClock } from "./useOpeningHoursClock";

/**
 * Applies the active opening-hours + facet filters to raw explore results.
 * Shared by `useFilteredCategoryResults` and `useTextSearchResults` so both
 * explore code paths filter identically from a single source of truth.
 */
export function useExploreFilters(
  rawResults: CategoryPlace[] | undefined,
): CategoryPlace[] | undefined {
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const openAtDay = useOpeningHoursStore((s) => s.openAtDay);
  const openAtHour = useOpeningHoursStore((s) => s.openAtHour);
  const facetSelections = useCategoryFacetStore((s) => s.selections);
  const now = useOpeningHoursClock();

  return useMemo(() => {
    if (!rawResults) return rawResults;
    const current = presentCategoryOpeningHours(rawResults, now);
    const byHours = applyHoursFilter(current, openingHoursFilter, openAtDay, openAtHour);
    return applyFacetFilters(byHours, facetSelections);
  }, [rawResults, openingHoursFilter, openAtDay, openAtHour, facetSelections, now]);
}
