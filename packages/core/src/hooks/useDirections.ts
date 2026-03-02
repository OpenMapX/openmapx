import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { DirectionsResult, TravelMode } from "../types/directions";
import type { LngLat } from "../types/geometry";

interface UseDirectionsParams {
  origin: LngLat | null;
  destination: LngLat | null;
  mode?: TravelMode;
}

// Phase 5 — wire up once OSRM/Valhalla is running
export function useDirections({ origin, destination, mode = "driving" }: UseDirectionsParams) {
  return useQuery({
    queryKey: ["directions", origin, destination, mode],
    queryFn: () =>
      apiClient.get<DirectionsResult>(API_ENDPOINTS.directions, {
        originLng: String(origin?.[0]),
        originLat: String(origin?.[1]),
        destLng: String(destination?.[0]),
        destLat: String(destination?.[1]),
        mode,
      }),
    enabled: origin !== null && destination !== null,
    staleTime: 120_000,
  });
}
