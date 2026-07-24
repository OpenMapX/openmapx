import type { BBox } from "../types/geometry";
import type {
  RoadConditionEvent,
  RoadConditionSeverity,
  RoadConditionType,
} from "../types/roadConditions";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface FetchRoadConditionsOptions {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
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
  return {
    id,
    source: str(p.source) ?? "",
    provider: str(p.provider) ?? "",
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
