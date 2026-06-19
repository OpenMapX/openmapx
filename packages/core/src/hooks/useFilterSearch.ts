import type { CategoryPlace } from "@integrations/poi-search/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { BoundingBox } from "../types/geometry";
import { normalizeFilter, type OverpassFilter } from "../utils/overpassFilter";
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
    queryFn: () =>
      apiClient.post<{ results: CategoryPlace[]; partial: boolean }>(API_ENDPOINTS.poiFilter, {
        filter,
        south: bbox?.south,
        west: bbox?.west,
        north: bbox?.north,
        east: bbox?.east,
        ...(lang && { lang }),
      }),
    enabled: filter !== null && filter.selectors.length > 0 && bbox !== null,
    staleTime: 30_000,
    retry: (_count, error) => !isAreaTooLarge(error),
  });
}
