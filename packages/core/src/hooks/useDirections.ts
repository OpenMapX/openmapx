import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { DirectionsResult, TravelMode } from "../types/directions";
import type { LngLat } from "../types/geometry";

interface UseDirectionsParams {
  origin: LngLat | null;
  destination: LngLat | null;
  mode?: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
}

export function useDirections({
  origin,
  destination,
  mode = "driving",
  avoidHighways = false,
  avoidTolls = false,
  avoidFerries = false,
  units = "metric",
  lang,
}: UseDirectionsParams) {
  return useQuery({
    queryKey: [
      "directions",
      origin,
      destination,
      mode,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
    ],
    queryFn: () =>
      apiClient.get<DirectionsResult>(API_ENDPOINTS.directions, {
        originLng: String(origin?.[0]),
        originLat: String(origin?.[1]),
        destLng: String(destination?.[0]),
        destLat: String(destination?.[1]),
        mode,
        avoidHighways: String(avoidHighways),
        avoidTolls: String(avoidTolls),
        avoidFerries: String(avoidFerries),
        units,
        ...(lang && { lang }),
      }),
    enabled: origin !== null && destination !== null,
    staleTime: 120_000,
    gcTime: 600_000, // Keep cached 10 min so switching back to a mode reuses data
  });
}
