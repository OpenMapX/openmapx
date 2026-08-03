import type { BBox } from "../types/geometry";
import type {
  RoadConditionEvent,
  RoadConditionSeverity,
  RoadConditionType,
  RouteFlowInput,
  RouteFlowResponse,
  RouteFlowSpan,
} from "../types/roadConditions";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface FetchRoadConditionsOptions {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
  /**
   * Keep only conditions in effect within the next `n` days (`0` = active now).
   * Omit for no temporal filter — navigation relies on that, since it evaluates
   * validity at the chosen travel time and must still see future closures.
   */
  horizonDays?: number;
}

interface RoadConditionFeature {
  geometry: RoadConditionEvent["geometry"];
  properties: Record<string, unknown> | null;
}

interface RoadConditionFeatureCollection {
  features?: RoadConditionFeature[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function featureToEvent(feature: RoadConditionFeature): RoadConditionEvent | null {
  const p = feature.properties ?? {};
  const id = str(p.id);
  if (!feature.geometry || !id) return null;
  const groupId = str(p.groupId);
  return {
    id,
    source: str(p.source) ?? "",
    provider: str(p.provider) ?? "",
    ...(groupId ? { groupId } : {}),
    type: (str(p.type) ?? "other") as RoadConditionType,
    severity: (str(p.severity) ?? "unknown") as RoadConditionSeverity,
    geometry: feature.geometry,
    headline: str(p.headline) ?? "",
    description: str(p.description),
    ...(typeof p.delaySeconds === "number" ? { delaySeconds: p.delaySeconds } : {}),
    roadState: p.roadState as RoadConditionEvent["roadState"],
    roads: (p.roads as RoadConditionEvent["roads"]) ?? undefined,
    validFrom: (p.validFrom as string | null) ?? null,
    validTo: (p.validTo as string | null) ?? null,
    dataUpdatedAt: str(p.dataUpdatedAt),
    attribution: (p.attribution as RoadConditionEvent["attribution"]) ?? undefined,
    ...(typeof p.isForecast === "boolean" ? { isForecast: p.isForecast } : {}),
    ...(typeof p.isPlanned === "boolean" ? { isPlanned: p.isPlanned } : {}),
  };
}

/**
 * Fetch road-condition events within a bounding box from the `road-conditions`
 * capability route, parsing the GeoJSON FeatureCollection back into the
 * provider-agnostic `RoadConditionEvent[]`. Returns [] on any error — this is an
 * optional layer (overlay + nav) that must never break the caller.
 */
export async function fetchRoadConditions(
  bbox: BBox,
  opts?: FetchRoadConditionsOptions,
): Promise<RoadConditionEvent[]> {
  try {
    const params: Record<string, string> = { bbox: bbox.join(",") };
    if (opts?.types && opts.types.length > 0) params.types = opts.types.join(",");
    if (opts?.minSeverity) params.minSeverity = opts.minSeverity;
    // `0` is a meaningful horizon ("active now"), so test for presence.
    if (opts?.horizonDays != null) params.horizonDays = String(opts.horizonDays);
    const fc = await apiClient.get<RoadConditionFeatureCollection>(
      API_ENDPOINTS.roadConditions,
      params,
    );
    return (fc.features ?? [])
      .map(featureToEvent)
      .filter((e): e is RoadConditionEvent => e !== null);
  } catch {
    return [];
  }
}

/**
 * Live flow along each route, keyed by the id the caller submitted. Returns an
 * empty map on any failure: congestion is decoration on a route that has to
 * keep drawing without it.
 */
export async function fetchRouteFlow(
  routes: RouteFlowInput[],
): Promise<Record<string, RouteFlowSpan[]>> {
  if (routes.length === 0) return {};
  try {
    const result = await apiClient.post<RouteFlowResponse>(API_ENDPOINTS.roadConditionsFlowRoute, {
      routes,
    });
    const out: Record<string, RouteFlowSpan[]> = {};
    for (const entry of result.routes ?? []) out[entry.id] = entry.spans ?? [];
    return out;
  } catch {
    return {};
  }
}
