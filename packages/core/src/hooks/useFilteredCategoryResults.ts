import { useMemo } from "react";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import { applyHoursFilter } from "../utils/categoryFilter";
import { useCategorySearch } from "./useCategorySearch";

/**
 * Returns category search results filtered by the active opening-hours filter.
 * Shared between CategoryResultMarkers and CategoryResultsPanel so both
 * consume the same filtered list (single source of truth).
 */
export function useFilteredCategoryResults() {
  const { activeCategory, searchBbox, openingHoursFilter, openAtDay, openAtHour } =
    useCategorySearchStore();

  const isTransitCategory = activeCategory === "transit";
  const {
    data: rawResults,
    isLoading,
    isError,
  } = useCategorySearch(isTransitCategory ? null : activeCategory, searchBbox);

  const filtered = useMemo(
    () =>
      rawResults
        ? applyHoursFilter(rawResults, openingHoursFilter, openAtDay, openAtHour)
        : rawResults,
    [rawResults, openingHoursFilter, openAtDay, openAtHour],
  );

  return { rawResults, filtered, isLoading, isError, isTransitCategory };
}
