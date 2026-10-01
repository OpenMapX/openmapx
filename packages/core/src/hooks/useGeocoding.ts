import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { SearchResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";

/** `proximity` biases results towards a point, rounded to 2 dp (~1 km) like the server cache. */
export function useGeocoding(query: string, lang?: string, proximity?: LngLat | null) {
  const location = proximity
    ? { lat: proximity[1].toFixed(2), lng: proximity[0].toFixed(2) }
    : undefined;
  return useQuery({
    queryKey: ["geocode", query, lang, location?.lat, location?.lng],
    queryFn: ({ signal }) =>
      apiClient.get<SearchResult[]>(
        API_ENDPOINTS.geocode,
        { q: query, ...(lang && { lang }), ...location },
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
