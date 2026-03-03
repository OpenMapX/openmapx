import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";
import type { Place } from "../types/place";

export function usePlaceDetails(placeId: string | null, coordinates?: LngLat, name?: string) {
  return useQuery({
    queryKey: ["place", placeId],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (coordinates) {
        params.lat = String(coordinates[1]);
        params.lng = String(coordinates[0]);
      }
      if (name) params.name = name;
      // placeId is guaranteed non-null here because of `enabled: placeId !== null`
      const id = placeId as string;
      return apiClient.get<Place>(`${API_ENDPOINTS.places}/${encodeURIComponent(id)}`, params);
    },
    enabled: placeId !== null,
    staleTime: 300_000,
  });
}
