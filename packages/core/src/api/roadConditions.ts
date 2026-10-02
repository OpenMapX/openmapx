import type { BBox } from "../types/geometry";
import type {
  LocalizedText,
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionSeverityLabel,
  RouteFlowInput,
  RouteFlowResponse,
  RouteFlowSpan,
} from "../types/roadConditions";
import {
  readRoadConditionEffects,
  roadConditionValiditySchema,
} from "../utils/roadConditionEffects";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

export interface FetchRoadConditionsOptions {
  /** Registry kind codes. */
  kinds?: string[];
  /** Registry type codes. */
  types?: string[];
  minSeverity?: RoadConditionSeverityLabel;
  /**
   * Keep only conditions in effect within the next `n` days (`0` = active now).
   * Omit for no temporal filter — navigation relies on that, since it evaluates
   * validity at the chosen travel time and must still see future closures.
   */
  horizonDays?: number;
  /** Abort an obsolete viewport/route request without publishing stale data. */
  signal?: AbortSignal;
}

export interface FetchRoadConditionsResult {
  events: RoadConditionEvent[];
  ok: boolean;
}

export interface RoadConditionFeature {
  geometry?: RoadConditionEvent["geometry"] | null;
  properties?: Record<string, unknown> | null;
}

interface RoadConditionFeatureCollection {
  features?: RoadConditionFeature[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * A genuine `{ type: "FeatureCollection", features: [] }` must read as
 * `ok: true` with zero events — that is the whole point of distinguishing it
 * from a failed aggregation (see `fetchRoadConditionsWithStatus`). So the only
 * shapes this rejects are ones a well-formed response could never take: a
 * non-object body, or a `features` field present but not an array.
 */
function isWellFormedFeatureCollection(v: unknown): v is RoadConditionFeatureCollection {
  if (typeof v !== "object" || v === null) return false;
  if (!("features" in v)) return true;
  return Array.isArray((v as { features: unknown }).features);
}

const SEVERITY_LABELS = ["minor", "moderate", "major", "critical", "unknown"] as const;
const CERTAINTIES = ["observed", "likely", "possible", "unlikely", "unknown"] as const;
const TEMPORALITIES = ["live", "scheduled", "forecast"] as const;
const ORIGINS = ["feed", "crowd", "federation", "derived"] as const;

function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return values.includes(v as T) ? (v as T) : fallback;
}

function object(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function text(v: unknown): LocalizedText | undefined {
  if (!Array.isArray(v)) return undefined;
  const entries = v.filter(
    (t): t is { lang: string; text: string } =>
      !!object(t) && typeof t.lang === "string" && typeof t.text === "string",
  );
  return entries.length > 0 ? entries.map(({ lang, text }) => ({ lang, text })) : undefined;
}

/** The roads a feature names, keeping only well-typed fields: consumers call string and array methods on them. */
function roads(v: unknown): RoadConditionRoadRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((raw): RoadConditionRoadRef[] => {
    const road = object(raw);
    if (!road) return [];
    const name = text(road.name);
    const ref: RoadConditionRoadRef = {
      ...(str(road.ref) ? { ref: str(road.ref) } : {}),
      ...(name ? { name } : {}),
      ...(str(road.class) ? { class: str(road.class) } : {}),
      ...(str(road.from) ? { from: str(road.from) } : {}),
      ...(str(road.to) ? { to: str(road.to) } : {}),
    };
    return Object.keys(ref).length > 0 ? [ref] : [];
  });
  return out.length > 0 ? out : undefined;
}

function direction(v: unknown): RoadConditionEvent["direction"] {
  const d = object(v);
  const value = str(d?.value);
  if (!d || !value) return undefined;
  return {
    value,
    ...(str(d.compass) ? { compass: str(d.compass) } : {}),
    ...(str(d.text) ? { text: str(d.text) } : {}),
  };
}

/**
 * One transported situation, read back into the contract. A feature without
 * an id, a classification or a readable validity is dropped: it cannot be
 * shown truthfully. Effects are validated one by one; an unreadable effect
 * stays as `unsupported` restriction evidence rather than vanishing. An
 * unknown origin reads as `crowd`, which never routes on its own.
 */
export function roadConditionFeatureToEvent(
  feature: RoadConditionFeature,
): RoadConditionEvent | null {
  const p = feature.properties ?? {};
  const id = str(p.id);
  const kind = str(p.kind);
  const type = str(p.type);
  const validity = roadConditionValiditySchema.safeParse(p.validity);
  if (!feature.geometry || !id || !kind || !type || !validity.success) return null;
  const severity = object(p.severity);
  const attribution = object(p.attribution);
  const evidence = object(p.evidence);
  const roadRefs = roads(p.roads);
  const affectedDirection = direction(p.direction);
  const headline = text(p.headline);
  const description = text(p.description);
  return {
    id,
    source: str(p.source) ?? "",
    provider: str(p.provider) ?? "",
    ...(str(p.groupId) ? { groupId: str(p.groupId) } : {}),
    kind,
    type,
    ...(str(p.subtype) ? { subtype: str(p.subtype) } : {}),
    severity: {
      label: oneOf(SEVERITY_LABELS, severity?.label, "unknown"),
      ...(typeof severity?.level === "number" ? { level: severity.level } : {}),
    },
    certainty: oneOf(CERTAINTIES, p.certainty, "unknown"),
    temporality: oneOf(TEMPORALITIES, p.temporality, "live"),
    planned: p.planned === true,
    ...(headline ? { headline } : {}),
    ...(description ? { description } : {}),
    geometry: feature.geometry,
    ...(roadRefs ? { roads: roadRefs } : {}),
    ...(affectedDirection ? { direction: affectedDirection } : {}),
    validity: validity.data,
    effects: readRoadConditionEffects(p.effects),
    origin: oneOf(ORIGINS, p.origin, "crowd"),
    ...(evidence && typeof evidence.state === "string"
      ? { evidence: evidence as RoadConditionEvent["evidence"] }
      : {}),
    attribution: {
      provider: str(attribution?.provider) ?? str(p.source) ?? "",
      ...(str(attribution?.license) ? { license: str(attribution?.license) } : {}),
      ...(str(attribution?.url) ? { url: str(attribution?.url) } : {}),
    },
    ...(str(p.updatedAt) ? { updatedAt: str(p.updatedAt) } : {}),
    fetchedAt: str(p.fetchedAt) ?? "",
    ...(str(p.expiresAt) ? { expiresAt: str(p.expiresAt) } : {}),
    ...(object(p.routingEvidence)
      ? { routingEvidence: p.routingEvidence as RoadConditionEvent["routingEvidence"] }
      : {}),
  };
}

/**
 * Fetch road-condition events with an explicit transport status. This lets
 * interactive overlays retain their last good data when a refresh fails.
 */
export async function fetchRoadConditionsWithStatus(
  bbox: BBox,
  opts?: FetchRoadConditionsOptions,
): Promise<FetchRoadConditionsResult> {
  try {
    const params: Record<string, string> = { bbox: bbox.join(",") };
    if (opts?.kinds && opts.kinds.length > 0) params.kinds = opts.kinds.join(",");
    if (opts?.types && opts.types.length > 0) params.types = opts.types.join(",");
    if (opts?.minSeverity) params.minSeverity = opts.minSeverity;
    // `0` is a meaningful horizon ("active now"), so test for presence.
    if (opts?.horizonDays != null) params.horizonDays = String(opts.horizonDays);
    const raw = opts?.signal
      ? await apiClient.get<unknown>(API_ENDPOINTS.roadConditions, params, { signal: opts.signal })
      : await apiClient.get<unknown>(API_ENDPOINTS.roadConditions, params);
    if (!isWellFormedFeatureCollection(raw)) return { ok: false, events: [] };
    return {
      ok: true,
      events: (raw.features ?? [])
        .map(roadConditionFeatureToEvent)
        .filter((e): e is RoadConditionEvent => e !== null),
    };
  } catch {
    return { ok: false, events: [] };
  }
}

/**
 * Compatibility wrapper for optional callers that intentionally treat a
 * transport failure as an empty result.
 */
export async function fetchRoadConditions(
  bbox: BBox,
  opts?: FetchRoadConditionsOptions,
): Promise<RoadConditionEvent[]> {
  const result = await fetchRoadConditionsWithStatus(bbox, opts);
  return result.events;
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
