import type { LngLat } from "../types/geometry";
import type {
  DirectionsResult,
  EvDirectionsRequest,
  EvDirectionsResult,
  TravelMode,
} from "../types/routing";
import { type ApiClient, type ApiRequestOptions, apiClient } from "./client";
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

/**
 * Plain (hook-free) directions fetch, shared by useDirections, the browser
 * reroute path and the mobile background reroute.
 *
 * The client is injectable so the native caller can pass one bound to the
 * compiled API origin with `credentials: "omit"`; existing callers keep the
 * browser singleton by default.
 */
export function fetchDirections(
  {
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
  }: FetchDirectionsParams,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<DirectionsResult> {
  const waypointsStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
  return client.get<DirectionsResult>(
    API_ENDPOINTS.directions,
    {
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
    },
    options,
  );
}

/** Plan an EV route with charge stops inserted, via `POST /directions/ev`. */
export function postEvDirections(
  req: EvDirectionsRequest,
  client: ApiClient = apiClient,
  options: ApiRequestOptions = {},
): Promise<EvDirectionsResult> {
  return client.post<EvDirectionsResult>(API_ENDPOINTS.directionsEv, req, options);
}
