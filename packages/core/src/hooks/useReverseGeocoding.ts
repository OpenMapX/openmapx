import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { ReverseGeocodingResult } from "../types/search";

export function useReverseGeocoding(lngLat: LngLat | null, lang?: string) {
  return useQuery({
    queryKey: ["reverse-geocode", lngLat?.[0], lngLat?.[1], lang],
    queryFn: () => {
      if (!lngLat) return Promise.resolve(null);
      return apiClient.get<ReverseGeocodingResult | null>(API_ENDPOINTS.geocodeReverse, {
        lat: String(lngLat[1]),
        lng: String(lngLat[0]),
        ...(lang && { lang }),
      });
    },
    enabled: lngLat !== null,
    staleTime: 60_000,
  });
}
