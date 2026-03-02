import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { Place } from "../types/place";

// Phase 4 — wire up once place API is running
export function usePlaceDetails(placeId: string | null) {
  return useQuery({
    queryKey: ["place", placeId],
    queryFn: () => apiClient.get<Place>(`${API_ENDPOINTS.places}/${placeId}`),
    enabled: placeId !== null,
    staleTime: 300_000,
  });
}
