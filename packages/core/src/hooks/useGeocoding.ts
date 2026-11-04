import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { fetchGeocode } from "../api/geocoding";
import { apiQueryRequestOptions, RAPID_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";

/** `proximity` biases results towards a point, rounded to 2 dp (~1 km) like the server cache. */
export function useGeocoding(query: string, lang?: string, proximity?: LngLat | null) {
  const location = proximity
    ? { lat: proximity[1].toFixed(2), lng: proximity[0].toFixed(2) }
    : undefined;
  return useQuery({
    queryKey: ["geocode", query, lang, location?.lat, location?.lng],
    queryFn: ({ signal }) =>
      fetchGeocode(
        { q: query, lang, proximity },
        apiClient,
        apiQueryRequestOptions(signal, RAPID_QUERY_POLICY),
      ),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
    gcTime: RAPID_QUERY_POLICY.gcTime,
  });
}
