import type { DirectionsResult, TravelMode } from "@integrations/routing/types";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";

interface UseDirectionsParams {
  waypoints: LngLat[];
  mode?: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
}

export function useDirections({
  waypoints,
  mode = "driving",
  avoidHighways = false,
  avoidTolls = false,
  avoidFerries = false,
  units = "metric",
  lang,
}: UseDirectionsParams) {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");

  return useQuery({
    queryKey: [
      "directions",
      waypointsStr,
      mode,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
    ],
    queryFn: () =>
      apiClient.get<DirectionsResult>(API_ENDPOINTS.directions, {
        waypoints: waypointsStr,
        mode,
        avoidHighways: String(avoidHighways),
        avoidTolls: String(avoidTolls),
        avoidFerries: String(avoidFerries),
        units,
        ...(lang && { lang }),
      }),
    enabled: waypoints.length >= 2,
    staleTime: 120_000,
    gcTime: 600_000,
  });
}
