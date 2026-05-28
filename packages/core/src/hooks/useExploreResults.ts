import { useMemo } from "react";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import { searchResultToCategoryPlace } from "../utils/searchResultToCategoryPlace";
import { useExploreTextSearch } from "./useExploreTextSearch";
import { useFilteredCategoryResults } from "./useFilteredCategoryResults";

/**
 * Single source of truth for explore results. In category mode it returns the
 * hours-filtered category results; in text mode it returns the proximity-biased
 * geocode hits mapped to CategoryPlace. Both underlying hooks always run, but
 * only the active one fetches (the other is disabled by its `enabled` guard).
 */
export function useExploreResults(lang?: string) {
  const mode = useCategorySearchStore((s) => s.mode);
  const textQuery = useCategorySearchStore((s) => s.textQuery);
  const anchor = useCategorySearchStore((s) => s.anchor);

  const category = useFilteredCategoryResults();

  const text = useExploreTextSearch(
    mode === "text" ? textQuery : "",
    anchor?.coordinates ?? null,
    lang,
  );
  const textFiltered = useMemo(
    () => (text.data ? text.data.map(searchResultToCategoryPlace) : undefined),
    [text.data],
  );

  if (mode === "text") {
    return {
      filtered: textFiltered,
      isLoading: text.isLoading,
      isError: text.isError,
      error: text.error,
      partial: false,
      isTransitCategory: false,
      mode,
    };
  }
  return { ...category, mode };
}
