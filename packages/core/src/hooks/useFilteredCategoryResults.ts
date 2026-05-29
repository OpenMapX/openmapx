import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useCategorySearch } from "./useCategorySearch";
import { useExploreFilters } from "./useExploreFilters";

/**
 * Returns category search results filtered by the active opening-hours filter.
 * Shared between CategoryResultMarkers and CategoryResultsContent so both
 * consume the same filtered list (single source of truth).
 */
export function useFilteredCategoryResults() {
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);

  const isTransitCategory = activeCategory === "transit";
  const {
    data: response,
    isLoading,
    isError,
    error,
  } = useCategorySearch(isTransitCategory ? null : activeCategory, searchBbox);

  const rawResults = response?.results;
  const partial = response?.partial ?? false;

  const filtered = useExploreFilters(rawResults);

  return { rawResults, filtered, isLoading, isError, error, partial, isTransitCategory };
}
