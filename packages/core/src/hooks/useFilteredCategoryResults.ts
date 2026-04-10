import { useMemo } from "react";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useOpeningHoursStore } from "../stores/openingHoursStore";
import { applyHoursFilter } from "../utils/categoryFilter";
import { useCategorySearch } from "./useCategorySearch";

/**
 * Returns category search results filtered by the active opening-hours filter.
 * Shared between CategoryResultMarkers and CategoryResultsContent so both
 * consume the same filtered list (single source of truth).
 */
export function useFilteredCategoryResults() {
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const openAtDay = useOpeningHoursStore((s) => s.openAtDay);
  const openAtHour = useOpeningHoursStore((s) => s.openAtHour);

  const isTransitCategory = activeCategory === "transit";
  const {
    data: response,
    isLoading,
    isError,
    error,
  } = useCategorySearch(isTransitCategory ? null : activeCategory, searchBbox);

  const rawResults = response?.results;
  const partial = response?.partial ?? false;

  const filtered = useMemo(
    () =>
      rawResults
        ? applyHoursFilter(rawResults, openingHoursFilter, openAtDay, openAtHour)
        : rawResults,
    [rawResults, openingHoursFilter, openAtDay, openAtHour],
  );

  return { rawResults, filtered, isLoading, isError, error, partial, isTransitCategory };
}
