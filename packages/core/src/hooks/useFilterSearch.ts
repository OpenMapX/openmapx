import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { CategorySearchResponse } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import { normalizeFilter, type OverpassFilter, type TagPredicate } from "../utils/overpassFilter";
import { isAreaTooLarge } from "./useCategorySearch";

export function useFilterSearch(
  filter: OverpassFilter | null,
  bbox: BoundingBox | null,
  lang?: string,
) {
  return useQuery({
    queryKey: [
      "filter-search",
      filter !== null ? JSON.stringify(normalizeFilter(filter)) : null,
      bbox,
      lang,
    ],
    queryFn: ({ signal }) =>
      apiClient.post<CategorySearchResponse & { relaxed?: TagPredicate[] }>(
        API_ENDPOINTS.poiFilter,
        {
          filter,
          south: bbox?.south,
          west: bbox?.west,
          north: bbox?.north,
          east: bbox?.east,
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      ),
    enabled: filter !== null && filter.selectors.length > 0 && bbox !== null,
    staleTime: 30_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
    retry: (_count, error) => !isAreaTooLarge(error),
  });
}
