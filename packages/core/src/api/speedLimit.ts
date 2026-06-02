import type { MatchResult, TravelMode } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/**
 * Map-match a short trace and return the posted speed limit (km/h) for the
 * edge under the LAST (most recent) trace point, or null when unknown.
 */
export async function fetchSpeedLimit(trace: LngLat[], mode: TravelMode): Promise<number | null> {
  if (trace.length < 2) return null;
  try {
    const res = await apiClient.post<MatchResult>(API_ENDPOINTS.routingMatch, {
      trace: trace.map(([lng, lat]) => ({ lat, lng })),
      mode,
      shapeMatch: "map_snap",
    });
    const point = res.points?.[res.points.length - 1];
    if (!point || point.edgeIndex === undefined) return null;
    const limit = res.edges?.[point.edgeIndex]?.speedLimit;
    return typeof limit === "number" && limit > 0 ? limit : null;
  } catch {
    return null;
  }
}
