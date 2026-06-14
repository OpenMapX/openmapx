import type { MatchResult, TravelMode } from "@integrations/routing/types";
import { matchSpeedLimitsByPoint } from "../navigation/speedLimits";
import { extractTrafficSignals } from "../navigation/trafficSignals";
import type { LngLat } from "../types/geometry";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface RouteMatchWindow {
  /** Traffic-signal coordinates along the matched window. */
  signals: LngLat[];
  /**
   * Posted speed limit (km/h) per matched trace point, aligned 1:1 to the input
   * window's points. The caller offsets these into a route-geometry-indexed
   * array (the window is a slice of `route.geometry`).
   */
  speedLimitsByPoint: (number | null)[];
}

/**
 * Map-match one route-geometry window and return both the traffic-signal
 * coordinates and the per-point speed limits along it, so navigation gets both
 * road attributes from a single request instead of polling. A failed lookup
 * (no map-matcher, network error, …) resolves to empty results — never throws,
 * matching {@link fetchTrafficSignals}.
 */
export async function fetchRouteMatchWindow(
  trace: LngLat[],
  mode: TravelMode,
): Promise<RouteMatchWindow> {
  if (trace.length < 2) return { signals: [], speedLimitsByPoint: [] };
  try {
    const res = await apiClient.post<MatchResult>(API_ENDPOINTS.routingMatch, {
      trace: trace.map(([lng, lat]) => ({ lat, lng })),
      mode,
      shapeMatch: "walk_or_snap",
    });
    // The caller offsets speedLimitsByPoint into a route-geometry-indexed array
    // (window point j → geometry[start + j]), which is only correct when the
    // matcher returns exactly one point per input trace point, in order. If the
    // count differs (a matcher that interpolates or drops points), the alignment
    // is broken, so skip the limits for this window rather than mis-index them;
    // signals are independent (keyed by edge endShapeIndex) and stay valid.
    const aligned = (res.points?.length ?? 0) === trace.length;
    return {
      signals: extractTrafficSignals(res),
      speedLimitsByPoint: aligned ? matchSpeedLimitsByPoint(res) : [],
    };
  } catch {
    return { signals: [], speedLimitsByPoint: [] };
  }
}
