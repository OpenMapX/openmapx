import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";

interface NearbyPlacesOptions {
  excludeId?: string;
  lang?: string;
  enabled?: boolean;
}

export function useNearbyPlaces(
  center: LngLat | null,
  radiusMetres = 1000,
  options: NearbyPlacesOptions = {},
) {
  return useQuery({
    queryKey: ["nearby", center, radiusMetres, options.excludeId, options.lang],
    queryFn: () => {
      if (!center) return Promise.resolve([] as Place[]);
      const params: Record<string, string> = {
        lng: String(center[0]),
        lat: String(center[1]),
        radius: String(radiusMetres),
      };
      if (options.excludeId) params.excludeId = options.excludeId;
      if (options.lang) params.lang = options.lang;
      return apiClient.get<Place[]>(API_ENDPOINTS.places, params);
    },
    enabled: center !== null && options.enabled !== false,
    staleTime: 60_000,
  });
}
