import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";

export function usePlaceDetails(
  placeId: string | null,
  coordinates?: LngLat,
  name?: string,
  lang?: string,
) {
  return useQuery({
    queryKey: ["place", placeId, name, lang],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (coordinates) {
        params.lat = String(coordinates[1]);
        params.lng = String(coordinates[0]);
      }
      if (name) params.name = name;
      if (lang) params.lang = lang;
      // placeId is guaranteed non-null here because of `enabled: placeId !== null`
      const id = placeId as string;
      return apiClient.get<Place>(`${API_ENDPOINTS.places}/${encodeURIComponent(id)}`, params);
    },
    enabled: placeId !== null,
    staleTime: 300_000,
  });
}
