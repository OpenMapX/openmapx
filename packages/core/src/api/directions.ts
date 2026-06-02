import type { DirectionsResult, TravelMode } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface FetchDirectionsParams {
  waypoints: LngLat[];
  mode?: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  units?: "metric" | "imperial";
  lang?: string;
  departAt?: string;
  arriveBy?: string;
}

/** Plain (hook-free) directions fetch, shared by useDirections and reroute. */
export function fetchDirections({
  waypoints,
  mode = "driving",
  avoidHighways = false,
  avoidTolls = false,
  avoidFerries = false,
  units = "metric",
  lang,
  departAt,
  arriveBy,
}: FetchDirectionsParams): Promise<DirectionsResult> {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
  return apiClient.get<DirectionsResult>(API_ENDPOINTS.directions, {
    waypoints: waypointsStr,
    mode,
    avoidHighways: String(avoidHighways),
    avoidTolls: String(avoidTolls),
    avoidFerries: String(avoidFerries),
    units,
    ...(lang && { lang }),
    ...(departAt && { departAt }),
    ...(arriveBy && { arriveBy }),
  });
}
