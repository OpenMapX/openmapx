import type { LngLat } from "../types/geometry";
import type { DirectionsResult, TravelMode } from "../types/routing";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface FetchDirectionsParams {
  waypoints: LngLat[];
  mode?: TravelMode;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
  /** When true, the server will inject active road closures as Valhalla exclusions. */
  avoidClosures?: boolean;
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
  avoidClosures = false,
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
    ...(avoidClosures && { avoidClosures: "1" }),
    units,
    ...(lang && { lang }),
    ...(departAt && { departAt }),
    ...(arriveBy && { arriveBy }),
  });
}
