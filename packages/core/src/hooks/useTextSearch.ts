import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import { useCategorySearchStore } from "../stores/categorySearchStore";
import type { CategorySearchResponse } from "../types/category";
import { detectDominantCategory } from "../utils/categoryFacets";
import { useExploreFilters } from "./useExploreFilters";

/**
 * Free-text POI search scoped to the active `searchBbox`. Mirrors
 * `useFilteredCategoryResults`: returns the raw Overpass results plus the
 * hours/facet-filtered list, and infers the dominant category so the filter
 * bar can show the right facets. Only fetches in text mode.
 */
export function useTextSearchResults(lang?: string) {
  const mode = useCategorySearchStore((s) => s.mode);
  const textQuery = useCategorySearchStore((s) => s.textQuery);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);

  const enabled = mode === "text" && textQuery.trim().length >= 2 && searchBbox !== null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["text-search", textQuery, searchBbox, lang],
    queryFn: ({ signal }) => {
      const bbox = searchBbox;
      if (!bbox) return { results: [], partial: false } satisfies CategorySearchResponse;
      return apiClient.get<CategorySearchResponse>(
        API_ENDPOINTS.textSearch,
        {
          q: textQuery,
          south: String(bbox.south),
          west: String(bbox.west),
          north: String(bbox.north),
          east: String(bbox.east),
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled,
    staleTime: 60_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });

  const rawResults = data?.results;
  const partial = data?.partial ?? false;
  const dominantCategory = useMemo(
    () => (rawResults ? detectDominantCategory(rawResults) : null),
    [rawResults],
  );
  const filtered = useExploreFilters(rawResults);

  return {
    rawResults,
    filtered,
    isLoading,
    isError,
    error,
    partial,
    truncated: data?.truncated ?? false,
    total: data?.total,
    dominantCategory,
  };
}
