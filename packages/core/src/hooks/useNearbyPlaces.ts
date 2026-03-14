import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";

// TODO: wire up once nearby-places API is implemented
export function useNearbyPlaces(center: LngLat | null, radiusMetres = 1000) {
  return useQuery({
    queryKey: ["nearby", center, radiusMetres],
    queryFn: () =>
      apiClient.get<Place[]>(API_ENDPOINTS.places, {
        lng: String(center?.[0]),
        lat: String(center?.[1]),
        radius: String(radiusMetres),
      }),
    enabled: center !== null,
    staleTime: 60_000,
  });
}
