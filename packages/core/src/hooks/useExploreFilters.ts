import type { CategoryPlace } from "@integrations/poi-search/types";
import { useMemo } from "react";
import { useCategoryFacetStore } from "../stores/categoryFacetStore";
import { useOpeningHoursStore } from "../stores/openingHoursStore";
import { applyFacetFilters } from "../utils/categoryFacets";
import { applyHoursFilter } from "../utils/categoryFilter";

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

  return useMemo(() => {
    if (!rawResults) return rawResults;
    const byHours = applyHoursFilter(rawResults, openingHoursFilter, openAtDay, openAtHour);
    return applyFacetFilters(byHours, facetSelections);
  }, [rawResults, openingHoursFilter, openAtDay, openAtHour, facetSelections]);
}
