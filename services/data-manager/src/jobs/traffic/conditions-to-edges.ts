import { createHash } from "node:crypto";
import {
  closesRoadForCars,
  getRoadConditionRoutingDecision,
  isRoadConditionRoutingEvidence,
  isRoutingRelevantBinding,
  type RoadConditionEffect,
  type RoadConditionEvent,
  type RoadConditionRoutingEvidence,
  readRoadConditionEffects,
  speedCapKph,
} from "@openmapx/core";
import type { WayEdge } from "./ways-to-edges.js";

export interface BoundSpan {
  wayId: number;
  dir: "f" | "b";
  startFraction: number;
  endFraction: number;
  /** Occupied part of the segment in travel direction, [lon, lat] pairs; null when OpenConditions could not cut it. */
  geometry: [number, number][] | null;
}

/** One bound effect of one road situation, as `/segments/conditions.json` lists it. */
export interface BoundCondition {
  /** `<recordId>#<effectId>`: names the effect in overrides, receipts and span keys. */
  id: string;
  recordId: string;
  source: string;
  cacheGeneration?: string;
  effect: RoadConditionEffect;
  routingEvidence: RoadConditionRoutingEvidence;
  origin: RoadConditionEvent["origin"];
  routingEligible: boolean;
  bindingStatus: string;
  segments: BoundSpan[];
}

export type EdgeOverride = { contributorIds?: string[] } & (
  | { closed: true; observationId: string }
  | { closed: false; capKph: number; observationId: string }
);

export interface ConditionsToEdgesResult {
  /** Keyed by `edgeKey` — `${level}:${tile}:${index}`. */
  overrides: Map<string, EdgeOverride & { edge: WayEdge }>;
  /** Condition ids (`<recordId>#<effectId>`) that produced at least one closed edge. */
  appliedObservationIds: Set<string>;
  /** Routing-relevant ways that are absent from the way→edge map. */
  missingWayIds: Set<number>;
  /** Spans whose edges came from `resolvedEdges`. */
  edgeExactSpans: number;
  /** Spans that fell back to every edge of the way in the bound direction. */
  wholeWaySpans: number;
  skipped: { notRelevant: number; crowdNotEligible: number; noEffect: number };
}

export function edgeKey(e: { level: number; tile: number; index: number }): string {
  return `${e.level}:${e.tile}:${e.index}`;
}

/**
 * Cache key for a traced span: the observation, the directed way, the occupied
 * fraction range, and the exact geometry. The fractions are part of the key
 * because two spans of one condition on the same directed way would otherwise
 * collide whenever both have `null` geometry. Fixed-precision formatting keeps
 * the key stable across runs.
 */
export function spanKey(observationId: string, span: BoundSpan): string {
  const geometryHash = createHash("md5")
    .update(JSON.stringify(span.geometry ?? null))
    .digest("hex")
    .slice(0, 16);
  const range = `${span.startFraction.toFixed(6)}-${span.endFraction.toFixed(6)}`;
  // Version the trace acceptance policy so an older partial-match verdict is never reused.
  return `trace-v2|${observationId}|${span.wayId}:${span.dir}|${range}|${geometryHash}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lineCoords(raw: unknown): [number, number][] | null {
  const geom = raw as { type?: unknown; coordinates?: unknown } | null | undefined;
  if (geom?.type !== "LineString" || !Array.isArray(geom.coordinates)) return null;
  const out: [number, number][] = [];
  for (const point of geom.coordinates as unknown[]) {
    if (!Array.isArray(point)) return null;
    const lon = point[0];
    const lat = point[1];
    // Validate rather than coerce: `Number(null)` is 0 and `Number(true)` is 1,
    // so coercion would turn a malformed coordinate into a plausible position
    // off the coast of Africa and feed it to the tracer as real geometry.
    if (typeof lon !== "number" || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    out.push([lon, lat]);
  }
  return out.length >= 2 ? out : null;
}

function parseSegments(raw: unknown): BoundSpan[] | null {
  if (!Array.isArray(raw)) return null;
  const segments: BoundSpan[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const span = entry as Record<string, unknown>;
    const wayId = span.way_id;
    const dir = span.dir;
    // Equal fractions are valid: a point-bound event carries a zero-length span
    // whose `geometry` is the short LineString OpenConditions cut around it.
    const startFraction = span.start_fraction;
    const endFraction = span.end_fraction;
    if (
      typeof wayId !== "number" ||
      !Number.isSafeInteger(wayId) ||
      wayId <= 0 ||
      typeof startFraction !== "number" ||
      typeof endFraction !== "number" ||
      startFraction < 0 ||
      endFraction > 1 ||
      startFraction > endFraction ||
      (dir !== "f" && dir !== "b") ||
      !Number.isFinite(startFraction) ||
      !Number.isFinite(endFraction)
    ) {
      return null;
    }
    const geometry = lineCoords(span.geometry);
    if (span.geometry != null && !geometry) return null;
    segments.push({ wayId, dir, startFraction, endFraction, geometry });
  }
  return segments;
}

const ORIGINS: ReadonlySet<string> = new Set(["feed", "crowd", "federation", "derived"]);

/**
 * Parses the `/segments/conditions.json` payload, schema version 2: one row
 * per bound effect of a road situation, snake_case on the wire, the effect
 * itself as the model publishes it. Any malformed row rejects the snapshot; a
 * partial publication must never replace the last complete stock. An effect
 * this host cannot read is kept as `unsupported` restriction evidence, which
 * never routes, so a newer producer cannot fail every closure with it.
 */
export function parseConditionsJson(body: string): {
  conditions: BoundCondition[];
  resolverVersion: string | null;
} {
  const parsed = JSON.parse(body) as {
    schema_version?: unknown;
    complete?: unknown;
    resolver_version?: unknown;
    conditions?: unknown;
  };
  if (parsed?.schema_version !== 2 || parsed.complete !== true || !Array.isArray(parsed.conditions))
    throw new Error("Invalid or incomplete road conditions snapshot");
  const conditions: BoundCondition[] = [];
  for (const raw of parsed.conditions as unknown[]) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid condition row");
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    const recordId = str(row.record_id);
    const effectId = str(row.effect_id);
    const source = str(row.source);
    const binding = (row.binding ?? {}) as Record<string, unknown>;
    const bindingStatus = str(binding.status);
    if (
      !id ||
      !recordId ||
      !effectId ||
      !source ||
      !bindingStatus ||
      id !== `${recordId}#${effectId}`
    )
      throw new Error("Invalid condition identity/binding");
    const effect = readRoadConditionEffects([row.effect])[0];
    if (!effect || effect.id !== effectId) throw new Error("Invalid condition effect");
    const segments = parseSegments(row.segments);
    if (!segments) throw new Error("Invalid condition spans");
    if (!isRoadConditionRoutingEvidence(row.routing_evidence))
      throw new Error("Invalid routing evidence");
    const evidence = row.routing_evidence;
    if (evidence.record_id !== recordId || evidence.effect_id !== effectId)
      throw new Error("Routing evidence names another effect");
    if (
      evidence.binding_status !== bindingStatus ||
      evidence.segments.length !== segments.length ||
      evidence.segments.some((span, i) => {
        const projected = segments[i];
        return (
          !projected ||
          span.segment_id !== `${projected.wayId}:${projected.dir}` ||
          (span.direction === "forward" ? "f" : "b") !== projected.dir ||
          span.from_fraction !== projected.startFraction ||
          span.to_fraction !== projected.endFraction
        );
      })
    )
      throw new Error("Routing evidence disagrees with projected binding");
    const origin = str(row.origin);
    conditions.push({
      id,
      recordId,
      source,
      effect,
      routingEvidence: evidence,
      // Defaults to the strict side: a row without a known origin must not
      // slip past the routing-eligibility gate as if it came from a feed.
      origin: origin && ORIGINS.has(origin) ? (origin as BoundCondition["origin"]) : "crowd",
      routingEligible: row.routing_eligible === true,
      bindingStatus,
      segments,
    });
  }
  return { conditions, resolverVersion: str(parsed.resolver_version) };
}

/** Whether a condition's origin may route: a feed outright, a crowd report once corroborated. */
function originRoutes(condition: Pick<BoundCondition, "origin" | "routingEligible">): boolean {
  return condition.origin === "feed" || condition.origin === "derived" || condition.routingEligible;
}

/**
 * Whether a condition could reach the override map at all: an origin that may
 * route and an effect a car's edge costing carries (a closure or a speed cap).
 * Lets the span tracer skip work `conditionsToEdges` would discard anyway.
 */
export function conditionCanRoute(condition: BoundCondition): boolean {
  return (
    originRoutes(condition) &&
    (closesRoadForCars(condition.effect) || speedCapKph(condition.effect) !== undefined)
  );
}

/**
 * Core's per-effect routing decision for one condition. The wire carries no
 * situation validity beyond what the evidence states, so the situation is
 * represented by the evidence's own window; an effect's own validity (and any
 * recurring periods in it) still comes from the effect.
 */
export function conditionRoutingDecision(
  condition: BoundCondition,
  options: Parameters<typeof getRoadConditionRoutingDecision>[2] = {},
): ReturnType<typeof getRoadConditionRoutingDecision> {
  const e = condition.routingEvidence;
  return getRoadConditionRoutingDecision(
    {
      id: condition.recordId,
      source: condition.source,
      validity: {
        status: "active",
        ...(e.valid_from ? { start: e.valid_from } : {}),
        ...(e.valid_to ? { end: e.valid_to } : {}),
      },
      origin: condition.origin,
      evidence: { state: "unknown", routingEligible: condition.routingEligible },
      routingEvidence: { [condition.effect.id]: e },
    },
    condition.effect,
    options,
  );
}

/**
 * Turns bound conditions into per-directed-edge overrides. A span uses the
 * traced edge subset from `resolvedEdges` when present (edge-exact); otherwise
 * only a proven full-way span may use its complete directed-way mapping. An
 * effect that closes the road for cars closes its edges; a mandatory speed
 * limit for every car caps them. Closure wins over cap; between caps the lower
 * one wins.
 */
export function conditionsToEdges(
  conditions: BoundCondition[],
  waysToEdges: Map<number, WayEdge[]>,
  resolvedEdges?: ReadonlyMap<string, WayEdge[]>,
  options: { evaluatedAt?: number; disallowedSources?: ReadonlySet<string> } = {},
): ConditionsToEdgesResult {
  const overrides = new Map<string, EdgeOverride & { edge: WayEdge }>();
  const appliedObservationIds = new Set<string>();
  const missingWayIds = new Set<number>();
  let edgeExactSpans = 0;
  let wholeWaySpans = 0;
  const skipped = { notRelevant: 0, crowdNotEligible: 0, noEffect: 0 };

  for (const condition of conditions) {
    // The emitter also publishes `ambiguous` bindings; those are display-only.
    if (!isRoutingRelevantBinding(condition.bindingStatus)) {
      skipped.notRelevant++;
      continue;
    }
    if (!originRoutes(condition)) {
      skipped.crowdNotEligible++;
      continue;
    }
    // A lorry restriction, an advisory or a delay changes nothing a car's
    // edge costing can carry.
    const closes = closesRoadForCars(condition.effect);
    const cap = closes ? undefined : speedCapKph(condition.effect);
    const capKph = cap !== undefined && Number.isFinite(cap) && cap > 0 ? cap : null;
    if (!closes && capKph === null) {
      skipped.noEffect++;
      continue;
    }
    if (!conditionRoutingDecision(condition, options).eligible) {
      skipped.notRelevant++;
      continue;
    }

    // Resolve the complete observation before emitting any overrides.
    const complete: Array<{ edges: WayEdge[]; exact: boolean }> = [];
    for (const span of condition.segments) {
      const wayEdges = waysToEdges.get(span.wayId);
      if (!wayEdges) {
        missingWayIds.add(span.wayId);
        continue;
      }
      const forward = span.dir === "f";
      const traced = resolvedEdges?.get(
        spanKey(
          condition.cacheGeneration ? `${condition.cacheGeneration}:${condition.id}` : condition.id,
          span,
        ),
      );
      const isEdgeExact = traced !== undefined && traced.length > 0;
      const fullWay = span.startFraction === 0 && span.endFraction === 1;
      const edges = (isEdgeExact ? traced : fullWay ? wayEdges : []).filter(
        (edge) => edge.forward === forward,
      );
      if (!edges.length) continue;
      complete.push({ edges, exact: isEdgeExact });
    }
    if (complete.length !== condition.segments.length || complete.length === 0) {
      skipped.notRelevant++;
      continue;
    }
    for (const { edges, exact: isEdgeExact } of complete) {
      if (isEdgeExact) edgeExactSpans++;
      else wholeWaySpans++;

      let touched = false;
      for (const edge of edges) {
        const key = edgeKey(edge);
        const previous = overrides.get(key);
        const contributorIds = [
          ...new Set([
            ...(previous?.contributorIds ?? (previous ? [previous.observationId] : [])),
            condition.id,
          ]),
        ];
        if (closes) {
          overrides.set(key, { closed: true, observationId: condition.id, contributorIds, edge });
          touched = true;
        } else if (
          capKph !== null &&
          (!previous || (!previous.closed && capKph < previous.capKph))
        ) {
          overrides.set(key, {
            closed: false,
            capKph,
            observationId: condition.id,
            contributorIds,
            edge,
          });
        } else if (previous) {
          overrides.set(key, { ...previous, contributorIds });
        }
      }
      if (closes && touched) appliedObservationIds.add(condition.id);
    }
  }

  return {
    overrides,
    appliedObservationIds,
    missingWayIds,
    edgeExactSpans,
    wholeWaySpans,
    skipped,
  };
}
