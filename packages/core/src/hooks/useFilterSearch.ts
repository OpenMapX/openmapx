import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { CategorySearchResponse } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import { normalizeFilter, type OverpassFilter, type TagPredicate } from "../utils/overpassFilter";
import { isAreaTooLarge } from "./useCategorySearch";

/**
 * Key, request and retry rule of one chain/filter search over one box, shared
 * by {@link useFilterSearch} and callers that search several boxes at once.
 */
export function filterSearchQueryOptions(filter: OverpassFilter, bbox: BoundingBox, lang?: string) {
  return {
    queryKey: ["filter-search", JSON.stringify(normalizeFilter(filter)), bbox, lang] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiClient.post<CategorySearchResponse & { relaxed?: TagPredicate[] }>(
        API_ENDPOINTS.poiFilter,
        {
          filter,
          south: bbox.south,
          west: bbox.west,
          north: bbox.north,
          east: bbox.east,
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    gcTime: MAP_QUERY_POLICY.gcTime,
    retry: (failureCount: number, error: unknown) => failureCount < 2 && !isAreaTooLarge(error),
  };
}

/** Never requested: the query stays disabled until a real box is known. */
const DISABLED_BBOX: BoundingBox = { south: 0, west: 0, north: 0, east: 0 };
const NO_FILTER: OverpassFilter = { selectors: [] };

export function useFilterSearch(
  filter: OverpassFilter | null,
  bbox: BoundingBox | null,
  lang?: string,
) {
  return useQuery({
    ...filterSearchQueryOptions(filter ?? NO_FILTER, bbox ?? DISABLED_BBOX, lang),
    queryKey: [
      "filter-search",
      filter !== null ? JSON.stringify(normalizeFilter(filter)) : null,
      bbox,
      lang,
    ],
    enabled: filter !== null && filter.selectors.length > 0 && bbox !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
