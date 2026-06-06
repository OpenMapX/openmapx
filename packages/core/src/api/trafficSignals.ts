import type { MatchResult, TravelMode } from "@integrations/routing/types";
import { extractTrafficSignals } from "../navigation/trafficSignals";
import type { LngLat } from "../types/geometry";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/**
 * Map-match a route-geometry window and return the traffic-signal coordinates
 * along it. A failed lookup (provider has no map-matcher, network error, …)
 * resolves to [] — never throws, matching {@link fetchSpeedLimit}.
 */
export async function fetchTrafficSignals(trace: LngLat[], mode: TravelMode): Promise<LngLat[]> {
  if (trace.length < 2) return [];
  try {
    const res = await apiClient.post<MatchResult>(API_ENDPOINTS.routingMatch, {
      trace: trace.map(([lng, lat]) => ({ lat, lng })),
      mode,
      shapeMatch: "walk_or_snap",
    });
    return extractTrafficSignals(res);
  } catch {
    return [];
  }
}
