import type { DirectionsResult, TravelMode } from "@integrations/routing/types";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LngLat } from "../types/geometry";

interface OptimizeRouteParams {
  waypoints: LngLat[];
  mode: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
}

export function useOptimizeRoute() {
  return useMutation({
    mutationFn: ({
      waypoints,
      mode,
      avoidHighways = false,
      avoidTolls = false,
      avoidFerries = false,
      units = "metric",
    }: OptimizeRouteParams) => {
      const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
      return apiClient.get<DirectionsResult>(API_ENDPOINTS.directionsOptimize, {
        waypoints: waypointsStr,
        mode,
        avoidHighways: String(avoidHighways),
        avoidTolls: String(avoidTolls),
        avoidFerries: String(avoidFerries),
        units,
      });
    },
  });
}
