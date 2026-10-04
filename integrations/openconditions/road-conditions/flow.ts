import type { RoadFlowSegment } from "@openmapx/integration-framework";

type Rec = Record<string, unknown>;

const LOS_VALUES: readonly RoadFlowSegment["los"][] = [
  "free_flow",
  "heavy",
  "queuing",
  "stationary",
  "unknown",
];
const CONFIDENCE_VALUES: readonly RoadFlowSegment["confidence"][] = [
  "measured",
  "estimated",
  "typical",
  "unknown",
];

function obj(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Coerce an upstream `los` value to the union, falling back to `"unknown"`
 * for anything absent or off-list (never trust an arbitrary upstream string). */
function los(v: unknown): RoadFlowSegment["los"] {
  const s = str(v);
  return s && (LOS_VALUES as readonly string[]).includes(s)
    ? (s as RoadFlowSegment["los"])
    : "unknown";
}

/** Coerce an upstream `confidence` value to the union, falling back to
 * `"typical"` for anything absent or off-list. */
function confidence(v: unknown): RoadFlowSegment["confidence"] {
  const s = str(v);
  return s && (CONFIDENCE_VALUES as readonly string[]).includes(s)
    ? (s as RoadFlowSegment["confidence"])
    : "typical";
}

/**
 * Maps one OpenConditions `/segments.geojson` feature to a `RoadFlowSegment`.
 * A base segment with no fused speed yet arrives with no speed properties at
 * all (the publisher omits null fields rather than sending them as `null`) —
 * that case maps to `los: "unknown"`, `confidence: "typical"`; both fields are
 * required on `RoadFlowSegment`, so this is the single place that invents that
 * default.
 */
function featureToRoadFlowSegment(feature: Rec, providerId: string): RoadFlowSegment | null {
  const geometry = obj(feature["geometry"]);
  const p = obj(feature["properties"]) ?? {};
  const id = str(p["segment_id"]);
  if (geometry?.["type"] !== "LineString" || !Array.isArray(geometry["coordinates"]) || !id) {
    return null;
  }

  return {
    id,
    geometry: geometry as unknown as RoadFlowSegment["geometry"],
    ...(num(p["current_kph"]) !== undefined ? { currentSpeedKph: num(p["current_kph"]) } : {}),
    ...(num(p["free_flow_kph"]) !== undefined ? { freeFlowSpeedKph: num(p["free_flow_kph"]) } : {}),
    ...(num(p["speed_ratio"]) !== undefined ? { speedRatio: num(p["speed_ratio"]) } : {}),
    los: los(p["los"]),
    confidence: confidence(p["confidence"]),
    direction: p["dir"] === "b" ? "b" : "f",
    ...(str(p["ref"]) !== undefined ? { roads: str(p["ref"]) } : {}),
    source: providerId,
    ...(str(p["observed_at"]) !== undefined ? { observedAt: str(p["observed_at"]) } : {}),
  };
}

/** The flow segments of a `/segments.geojson` body; anything else reads as none. */
export function featureCollectionToRoadFlowSegments(
  body: unknown,
  providerId: string,
): RoadFlowSegment[] {
  const features = obj(body)?.["features"];
  if (!Array.isArray(features)) return [];
  return features.flatMap((feature) => {
    const record = obj(feature);
    const segment = record ? featureToRoadFlowSegment(record, providerId) : null;
    return segment ? [segment] : [];
  });
}
