import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY, rateLimitAwareRetry } from "../api/queryPolicy";
import type { ReverseGeocodingResult } from "../types/geocoding";
import type { LngLat } from "../types/geometry";

export function useReverseGeocoding(lngLat: LngLat | null, lang?: string) {
  const fallbackRetry = useQueryClient().getDefaultOptions().queries?.retry;
  return useQuery({
    queryKey: ["reverse-geocode", lngLat?.[0], lngLat?.[1], lang],
    queryFn: ({ signal }) => {
      if (!lngLat) return Promise.resolve(null);
      return apiClient.get<ReverseGeocodingResult | null>(
        API_ENDPOINTS.geocodeReverse,
        {
          lat: String(lngLat[1]),
          lng: String(lngLat[0]),
          ...(lang && { lang }),
        },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
    },
    enabled: lngLat !== null,
    // A saved list labels each coordinate-only row with its own lookup, so a
    // long list outruns the per-client budget; wait out a 429 and retry.
    ...rateLimitAwareRetry(fallbackRetry),
    staleTime: 60_000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
}
