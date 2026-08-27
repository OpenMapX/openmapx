import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { apiQueryRequestOptions, MAP_QUERY_POLICY } from "../api/queryPolicy";
import type { LngLat } from "../types/geometry";

interface CountryResponse {
  countryCode: string | null;
}

/**
 * Resolve a lowercase ISO 3166-1 alpha-2 country code from coordinates via the
 * geocoding integration's country-level reverse lookup. For region-aware
 * features (e.g. food delivery) that need a country when the place itself
 * carries none. Disabled unless `enabled` and coordinates are provided.
 */
export function useCountryFromCoordinates(coordinates: LngLat | null, enabled = true) {
  const lng = coordinates?.[0];
  const lat = coordinates?.[1];
  return useQuery<string | null>({
    queryKey: ["country-from-coords", lat, lng],
    queryFn: async ({ signal }) => {
      if (typeof lat !== "number" || typeof lng !== "number") return null;
      const res = await apiClient.get<CountryResponse>(
        API_ENDPOINTS.geocodeCountry,
        { lat: String(lat), lng: String(lng) },
        apiQueryRequestOptions(signal, MAP_QUERY_POLICY),
      );
      return res.countryCode;
    },
    enabled: enabled && typeof lat === "number" && typeof lng === "number",
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: MAP_QUERY_POLICY.gcTime,
  });
}
