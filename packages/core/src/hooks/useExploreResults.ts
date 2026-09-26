import { useMemo } from "react";
import { AD_HOC_CATEGORY_ID, useCategorySearchStore } from "../stores/categorySearchStore";
import { useMapStore } from "../stores/mapStore";
import { useNlpSearchStore } from "../stores/nlpSearchStore";
import type { TagPredicate } from "../utils/overpassFilter";
import { resolveDistanceReference } from "../utils/resultReference";
import { sortResultsByIntent } from "../utils/sortResults";
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
 * The captured search origin/area is shared by displayed distances and intent
 * sorting. An NLP intent applies only while it belongs to the current search;
 * predicate edits retain that ownership.
 */
export function useExploreResults(lang?: string) {
  const mode = useCategorySearchStore((s) => s.mode);
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);
  const adHocFilter = useCategorySearchStore((s) => s.adHocFilter);
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const searchRevision = useCategorySearchStore((s) => s.searchRevision);
  const nlpSearchRevision = useCategorySearchStore((s) => s.nlpSearchRevision);
  const userLocation = useMapStore((s) => s.userLocation);

  const nlpIntent = useNlpSearchStore((s) => s.intent);
  const isNlpActive = useNlpSearchStore((s) => s.isNlpActive);
  const currentNlpIntent =
    isNlpActive &&
    mode === "category" &&
    activeCategory === AD_HOC_CATEGORY_ID &&
    !activeBrand &&
    adHocFilter !== null &&
    nlpSearchRevision === searchRevision
      ? nlpIntent
      : null;
  const distanceReference = useMemo(() => {
    const spatial = currentNlpIntent?.spatial_constraint;
    const searchOrigin =
      spatial?.type === "near_coordinates"
        ? { coordinates: [spatial.lng, spatial.lat] as [number, number] }
        : null;
    return resolveDistanceReference({
      anchor: currentNlpIntent ? null : anchor,
      searchBbox,
      searchOrigin,
      userLocation,
    });
  }, [anchor, currentNlpIntent, searchBbox, userLocation]);

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
    return sortResultsByIntent(
      base.filtered,
      currentNlpIntent?.sort_by,
      distanceReference?.coordinates ?? null,
    );
  }, [base.filtered, currentNlpIntent, distanceReference]);

  return {
    ...base,
    filtered,
    providerFiltered: base.filtered,
    defaultSort: currentNlpIntent?.sort_by,
    distanceReference,
  };
}
