import { useMemo } from "react";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useOpeningHoursStore } from "../stores/openingHoursStore";
import { applyHoursFilter } from "../utils/categoryFilter";
import type { TagPredicate } from "../utils/overpassFilter";
import { useCategorySearch } from "./useCategorySearch";
import { useExploreFilters } from "./useExploreFilters";
import { useFilterSearch } from "./useFilterSearch";

/**
 * Returns category search results filtered by the active opening-hours filter.
 * Shared between CategoryResultMarkers and CategoryResultsContent so both
 * consume the same filtered list (single source of truth).
 *
 * When an ad-hoc OverpassFilter is active (set via setAdHocFilter), results
 * come from useFilterSearch instead of useCategorySearch. In ad-hoc mode only
 * the opening-hours filter is applied client-side — tag/facet narrowing was
 * already done server-side in the Overpass QL.
 */
export function useFilteredCategoryResults() {
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);
  const adHocFilter = useCategorySearchStore((s) => s.adHocFilter);

  const isAdHoc = adHocFilter !== null;
  const isTransitCategory = activeCategory === "transit";

  const {
    data: categoryResponse,
    isLoading: categoryLoading,
    isError: categoryIsError,
    error: categoryError,
  } = useCategorySearch(isAdHoc || isTransitCategory ? null : activeCategory, searchBbox);

  const {
    data: filterResponse,
    isLoading: filterLoading,
    isError: filterIsError,
    error: filterError,
  } = useFilterSearch(isAdHoc ? adHocFilter : null, searchBbox);

  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const openAtDay = useOpeningHoursStore((s) => s.openAtDay);
  const openAtHour = useOpeningHoursStore((s) => s.openAtHour);

  const adHocRaw = filterResponse?.results;
  const adHocPartial = filterResponse?.partial ?? false;
  const adHocRelaxed = (filterResponse?.relaxed ?? []) as TagPredicate[];

  const adHocFiltered = useMemo(() => {
    if (!adHocRaw) return adHocRaw;
    return applyHoursFilter(adHocRaw, openingHoursFilter, openAtDay, openAtHour);
  }, [adHocRaw, openingHoursFilter, openAtDay, openAtHour]);

  const categoryRaw = categoryResponse?.results;
  const categoryPartial = categoryResponse?.partial ?? false;
  const categoryFiltered = useExploreFilters(isAdHoc ? undefined : categoryRaw);

  if (isAdHoc) {
    return {
      rawResults: adHocRaw,
      filtered: adHocFiltered,
      isLoading: filterLoading,
      isError: filterIsError,
      error: filterError,
      partial: adHocPartial,
      relaxed: adHocRelaxed,
      isTransitCategory: false,
    };
  }

  return {
    rawResults: categoryRaw,
    filtered: categoryFiltered,
    isLoading: categoryLoading,
    isError: categoryIsError,
    error: categoryError,
    partial: categoryPartial,
    relaxed: [] as TagPredicate[],
    isTransitCategory,
  };
}
