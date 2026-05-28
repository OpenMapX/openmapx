import type { SearchResult } from "@integrations/geocoding/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";

/**
 * Forward geocode for the explore free-text path, biased toward `proximity`
 * (the anchor place). Returns raw SearchResult[]; callers map to CategoryPlace.
 */
export function useExploreTextSearch(query: string, proximity: LngLat | null, lang?: string) {
  return useQuery({
    queryKey: ["explore-text", query, proximity, lang],
    queryFn: () =>
      apiClient.get<SearchResult[]>(API_ENDPOINTS.geocode, {
        q: query,
        ...(proximity && { lat: String(proximity[1]), lng: String(proximity[0]) }),
        ...(lang && { lang }),
      }),
    enabled: query.trim().length > 0,
    staleTime: 60_000,
  });
}
