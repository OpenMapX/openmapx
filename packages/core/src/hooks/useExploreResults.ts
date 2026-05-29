import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useFilteredCategoryResults } from "./useFilteredCategoryResults";
import { useTextSearchResults } from "./useTextSearch";

/**
 * Single source of truth for explore results. In category mode it returns the
 * hours/facet-filtered category results; in text mode it returns the Overpass
 * free-text results (same rich shape, also filtered). Both underlying hooks
 * always run, but only the active one fetches (the other is disabled by its
 * `enabled` guard). `dominantCategory` is the category whose facet filters
 * apply — the active category in category mode, or the inferred majority
 * category of the text results.
 */
export function useExploreResults(lang?: string) {
  const mode = useCategorySearchStore((s) => s.mode);
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);

  const category = useFilteredCategoryResults();
  const text = useTextSearchResults(lang);

  if (mode === "text") {
    return { ...text, isTransitCategory: false, mode, dominantCategory: text.dominantCategory };
  }
  return { ...category, mode, dominantCategory: activeCategory as string | null };
}
