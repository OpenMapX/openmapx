import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { type BikeRoutingOptions, bicycleQueryParameters } from "../routing/bicycleOptions";
import type { LngLat } from "../types/geometry";
import type { DirectionsResult, TravelMode } from "../types/routing";

interface OptimizeRouteParams extends BikeRoutingOptions {
  waypoints: LngLat[];
  mode: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  /** Wall-clock departure time `YYYY-MM-DDTHH:mm`. Mutually exclusive with `arriveBy`. */
  departAt?: string;
  /** Wall-clock arrival time `YYYY-MM-DDTHH:mm`. Mutually exclusive with `departAt`. */
  arriveBy?: string;
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
      departAt,
      arriveBy,
      bikeProfile,
      bikeHillPreference,
      bikePreferQuietRoads,
    }: OptimizeRouteParams) => {
      const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
      return apiClient.get<DirectionsResult>(API_ENDPOINTS.directionsOptimize, {
        waypoints: waypointsStr,
        mode,
        ...bicycleQueryParameters(mode, { bikeProfile, bikeHillPreference, bikePreferQuietRoads }),
        avoidHighways: String(avoidHighways),
        avoidTolls: String(avoidTolls),
        avoidFerries: String(avoidFerries),
        units,
        ...(departAt && { departAt }),
        ...(arriveBy && { arriveBy }),
      });
    },
  });
}
