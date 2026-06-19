import { useMemo } from "react";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import { useMapStore } from "../stores/mapStore";
import { useNlpSearchStore } from "../stores/nlpSearchStore";
import type { LngLat } from "../types/geometry";
import type { TagPredicate } from "../utils/overpassFilter";
import { bboxCenter, sortResultsByIntent } from "../utils/sortResults";
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
 *
 * When an NL search is active its `sort_by` reorders the filtered list: the
 * distance reference is the centre of the resolved search bbox (stable for the
 * lifetime of the search) rather than the live map centre, so panning the map
 * does not re-sort the results. Non-NL searches carry no intent, so the list
 * keeps the backend's relevance order.
 */
export function useExploreResults(lang?: string) {
  const mode = useCategorySearchStore((s) => s.mode);
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);

  const sortBy = useNlpSearchStore((s) => s.intent?.sort_by);
  const resolvedBbox = useNlpSearchStore((s) => s.resolvedBbox);
  const userLocation = useMapStore((s) => s.userLocation);

  const category = useFilteredCategoryResults();
  const text = useTextSearchResults(lang);

  const base =
    mode === "text"
      ? {
          ...text,
          isTransitCategory: false,
          mode,
          dominantCategory: text.dominantCategory,
          relaxed: [] as TagPredicate[],
        }
      : { ...category, mode, dominantCategory: activeCategory as string | null };

  const filtered = useMemo(() => {
    const reference: LngLat | null = resolvedBbox ? bboxCenter(resolvedBbox) : userLocation;
    return sortResultsByIntent(base.filtered, sortBy, reference);
  }, [base.filtered, sortBy, resolvedBbox, userLocation]);

  return { ...base, filtered };
}
