import type {
  BBox,
  LngLat,
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRouteImpact,
  TravelMode,
} from "@openmapx/core";
import {
  closesRoadForCars,
  effectInForceAt,
  haversineDistance,
  isLocalAccessClosure,
} from "@openmapx/core";
import type { IntegrationContext, RoadConditionsProvider } from "@openmapx/integration-framework";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";

export interface ClosureExclusions {
  points: LngLat[];
  polygons: LngLat[][];
  roadConditionImpact: RoadConditionRouteImpact;
  /** Lines of the roads the engine's live traffic closes to all but local access. */
  localAccessLines: LngLat[][];
  /** Lines of the closures no car may use. */
  hardLines: LngLat[][];
  /**
   * Geometry of local-access closures with no routing evidence, not yet in
   * `points`/`polygons`: whether to exclude them depends on the route's ends.
   */
  legacyLocalAccess: Array<{ type: string; coordinates?: unknown }>;
}

/** The lines a closure geometry lies along; a point is a line of one vertex, a polygon its outer ring. */
export function geometryLines(geometry: { type: string; coordinates?: unknown }): LngLat[][] {
  const line = (coords: number[][]) => sampleCoords(coords);
  switch (geometry.type) {
    case "Point": {
      const p = toLngLat(geometry.coordinates as number[]);
      return p ? [[p]] : [];
    }
    case "MultiPoint":
      return (geometry.coordinates as number[][]).flatMap((c) => {
        const p = toLngLat(c);
        return p ? [[p]] : [];
      });
    case "LineString":
      return [line(geometry.coordinates as number[][])];
    case "MultiLineString":
      return (geometry.coordinates as number[][][]).map(line);
    case "Polygon":
      return [line((geometry.coordinates as number[][][])[0] ?? [])];
    case "MultiPolygon":
      return (geometry.coordinates as number[][][][]).map((poly) => line(poly[0] ?? []));
    case "GeometryCollection":
      return (
        (geometry as { geometries?: Array<{ type: string; coordinates?: unknown }> }).geometries ??
        []
      ).flatMap(geometryLines);
    default:
      return [];
  }
}

/**
 * Maximum spacing (metres) between consecutive exclusion points on a densified
 * closure line. Keeps point-based exclusion geometry representative of the
 * whole closed segment rather than only its source vertices.
 */
const MAX_EXCLUSION_SPACING_M = 45;

/**
 * Hard cap on exclusion points emitted per single closure geometry. Prevents a
 * single very-long LineString from producing unbounded generic route options.
 */
const MAX_EXCLUSION_POINTS_PER_CLOSURE = 300;

/**
 * Whether a crowd-sourced situation must be withheld from routing. A
 * user-reported closure becomes a route exclusion ONLY once its evidence made
 * it `routingEligible` (an external resolution corroborated it — peer votes
 * never do), the same rule core's routing decision and the OpenConditions
 * export apply. A `feed` or `derived` situation always keeps routing: dropping
 * an official closure would route a car into a real closed road.
 */
function isCrowdNonRoutable(event: Pick<RoadConditionEvent, "origin" | "evidence">): boolean {
  return (
    (event.origin === "crowd" || event.origin === "federation") &&
    event.evidence?.routingEligible !== true
  );
}

/**
 * Whether an effect is in force at the requested travel time `at`. Many feeds
 * publish planned closures days ahead, and some (e.g. nightly roadworks) are
 * active only inside recurring windows; without this check the router would
 * detour around a closure that hasn't started, has ended, or is only active at
 * night. `at` is the chosen departure/arrival instant, or "now" for an
 * immediate trip. The effect's own validity wins over its situation's; an
 * unparseable travel time never suppresses a closure.
 */
function inForceAt(event: RoadConditionEvent, effect: RoadConditionEffect, at: Date): boolean {
  return Number.isNaN(at.getTime()) || effectInForceAt(event, effect, at);
}

/** The place an effect closes: its own location when it has one, else its situation's. */
function effectGeometry(
  event: RoadConditionEvent,
  effect: RoadConditionEffect,
): { type: string; coordinates?: unknown } | undefined {
  const own = effect.location?.geometry as { type?: unknown } | null | undefined;
  if (own && typeof own === "object" && typeof own.type === "string") {
    return own as { type: string; coordinates?: unknown };
  }
  return event.geometry ?? undefined;
}

function toLngLat(coord: number[]): LngLat | null {
  if (coord.length < 2) return null;
  const [lng, lat] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng as number, lat as number];
}

/**
 * Densify a single line segment from `a` to `b` by inserting interpolated
 * [lng,lat] points whenever the segment exceeds MAX_EXCLUSION_SPACING_M. The
 * start vertex `a` is included; the end vertex `b` is NOT (the caller appends
 * it after the final segment to avoid duplicates).
 */
function densifySegment(a: LngLat, b: LngLat): LngLat[] {
  const dist = haversineDistance(a, b);
  const steps = Math.ceil(dist / MAX_EXCLUSION_SPACING_M);
  if (steps <= 1) return [a];
  const result: LngLat[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return result;
}

/**
 * Convert a LineString coordinate array into a densified set of [lng,lat]
 * exclusion points, capped at MAX_EXCLUSION_POINTS_PER_CLOSURE.
 */
function densifyLine(coords: number[][], ctx: IntegrationContext): LngLat[] {
  const vertices: LngLat[] = [];
  for (const c of coords) {
    const p = toLngLat(c);
    if (p) vertices.push(p);
  }
  if (vertices.length === 0) return [];
  if (vertices.length === 1) return [vertices[0] as LngLat];

  const out: LngLat[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const seg = densifySegment(vertices[i] as LngLat, vertices[i + 1] as LngLat);
    for (const pt of seg) {
      out.push(pt);
      if (out.length >= MAX_EXCLUSION_POINTS_PER_CLOSURE) {
        ctx.log.warn(
          `[routing/closures] closure line exceeded ${MAX_EXCLUSION_POINTS_PER_CLOSURE} exclusion points; trimming`,
        );
        return out;
      }
    }
  }
  const last = vertices[vertices.length - 1] as LngLat;
  if (out.length < MAX_EXCLUSION_POINTS_PER_CLOSURE) {
    out.push(last);
  } else {
    ctx.log.warn(
      `[routing/closures] closure line exceeded ${MAX_EXCLUSION_POINTS_PER_CLOSURE} exclusion points; trimming`,
    );
  }
  return out;
}

function sampleCoords(coords: number[][]): LngLat[] {
  const out: LngLat[] = [];
  for (const c of coords) {
    const p = toLngLat(c);
    if (p) out.push(p);
  }
  return out;
}

export function geometryToExclusions(
  geometry: { type: string; coordinates?: unknown },
  points: LngLat[],
  polygons: LngLat[][],
  ctx: IntegrationContext,
): void {
  switch (geometry.type) {
    case "Point": {
      const p = toLngLat(geometry.coordinates as number[]);
      if (p) points.push(p);
      break;
    }
    case "LineString": {
      points.push(...densifyLine(geometry.coordinates as number[][], ctx));
      break;
    }
    case "MultiLineString": {
      for (const line of geometry.coordinates as number[][][]) {
        points.push(...densifyLine(line, ctx));
      }
      break;
    }
    case "Polygon": {
      const ring = (geometry.coordinates as number[][][])[0] ?? [];
      const outer = sampleCoords(ring);
      if (outer.length >= 3) polygons.push(outer);
      break;
    }
    case "MultiPolygon": {
      for (const poly of geometry.coordinates as number[][][][]) {
        const outer = sampleCoords(poly[0] ?? []);
        if (outer.length >= 3) polygons.push(outer);
      }
      break;
    }
    case "MultiPoint": {
      // Push each point as its own exclusion — do NOT collapse to a centroid,
      // which can sit off-road between the two ends of a "between X and Y"
      // closure (the shape DATEX2 feeds emit for this case).
      for (const c of geometry.coordinates as number[][]) {
        const p = toLngLat(c);
        if (p) points.push(p);
      }
      break;
    }
    case "GeometryCollection": {
      const geometries =
        (geometry as { geometries?: Array<{ type: string; coordinates?: unknown }> }).geometries ??
        [];
      for (const g of geometries) {
        geometryToExclusions(g, points, polygons, ctx);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Collect the effects that close a road to cars at the travel time from all
 * registered road-conditions providers and convert them into generic
 * route-exclusion geometry. Provider adapters own any engine-specific
 * conversion, validation, and request-size limits.
 *
 * Each effect of a situation is judged on its own: a situation can close one
 * carriageway, cap the speed on another and restrict lorries on a third. Only
 * an effect with no routing evidence from a provider that publishes none falls
 * back to geometry; graph evidence is never projected back onto raw geometry.
 *
 * The routing integration depends only on the `road-conditions` capability
 * contract — never on `@openconditions/*` packages directly.
 */
export async function activeClosuresForBbox(
  ctx: IntegrationContext,
  bbox: BBox,
  at?: Date,
  mode: TravelMode = "driving",
): Promise<ClosureExclusions> {
  const refTime = at ?? new Date();
  const evaluatedAt = new Date();
  const unavailable = (reason: string): ClosureExclusions => ({
    points: [],
    polygons: [],
    localAccessLines: [],
    hardLines: [],
    legacyLocalAccess: [],
    roadConditionImpact: {
      availability: "unavailable",
      evaluatedAt: evaluatedAt.toISOString(),
      validUntil: null,
      reasons: [reason],
    },
  });
  const integrations = ctx.getIntegrationsByDomain("road-conditions");
  if (integrations.length === 0) return unavailable("no_road_condition_provider");

  const providers = integrations.flatMap(
    (i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[],
  );
  if (providers.length === 0) return unavailable("no_road_condition_provider");

  // Load every kind: graph-bound speed caps also need application
  // assessment. Geometry exclusions below retain the closure-only gate.
  const settled = await Promise.allSettled(providers.map((p) => p.getEvents(bbox, {})));

  const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
  const points: LngLat[] = [];
  const polygons: LngLat[][] = [];
  const localAccessLines: LngLat[][] = [];
  const hardLines: LngLat[][] = [];
  const legacyLocalAccess: Array<{ type: string; coordinates?: unknown }> = [];
  let sawLegacyGeometry = false;
  let sawRoutingEvidence = false;
  let providerFailed = false;
  const assessmentReasons = new Set<string>();
  const deadlines: number[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue;
    if (result.status === "rejected") {
      providerFailed = true;
      ctx.log.warn(
        `[routing/closures] road-conditions provider ${providers[i]?.id} failed`,
        result.reason,
      );
      continue;
    }
    for (const event of result.value) {
      if (disallowed.has(event.source)) continue;
      if (event.routingEvidence) sawRoutingEvidence = true;
      // Two closing effects of one situation without their own location
      // share its geometry; exclude it once.
      const excluded = new Set<object>();
      for (const effect of event.effects ?? []) {
        const routeDecision = assessRoadConditionForRoute(event, effect, {
          evaluatedAt: evaluatedAt.getTime(),
          travelAt: refTime.getTime(),
          mode,
          // This planning stage runs before any engine request. Request-bound
          // application is assessed against the actual returned route later.
          sharedTrafficApplied: false,
          allowLegacyGeometry: true,
          disallowedSources: disallowed,
        });
        for (const reason of routeDecision.reasons) assessmentReasons.add(reason);
        if (routeDecision.validUntil) {
          const deadline = Date.parse(routeDecision.validUntil);
          if (Number.isFinite(deadline)) deadlines.push(deadline);
        }
        if (routeDecision.disposition !== "legacy-geometry") {
          // A closure in the shared live traffic closes the road in the
          // engine; its line decides how the route's ends are relaxed.
          if (
            closesRoadForCars(effect) &&
            assessRoadConditionForRoute(event, effect, {
              evaluatedAt: evaluatedAt.getTime(),
              travelAt: refTime.getTime(),
              mode,
              sharedTrafficApplied: true,
              disallowedSources: disallowed,
            }).disposition === "shared-traffic"
          ) {
            const geometry = effectGeometry(event, effect);
            if (geometry) {
              (isLocalAccessClosure(effect) ? localAccessLines : hardLines).push(
                ...geometryLines(geometry),
              );
            }
          }
          continue;
        }
        sawLegacyGeometry = true;
        if (isCrowdNonRoutable(event)) continue;
        if (!closesRoadForCars(effect)) continue;
        if (!inForceAt(event, effect, refTime)) continue;
        const geometry = effectGeometry(event, effect);
        if (!geometry || excluded.has(geometry)) continue;
        excluded.add(geometry);
        if (isLocalAccessClosure(effect)) {
          legacyLocalAccess.push(geometry);
          continue;
        }
        hardLines.push(...geometryLines(geometry));
        geometryToExclusions(geometry, points, polygons, ctx);
      }
    }
  }

  const validUntil = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  let availability: RoadConditionRouteImpact["availability"];
  if (sawLegacyGeometry) availability = "limited";
  else if (sawRoutingEvidence) availability = "unsupported";
  else availability = "unavailable";
  if (!sawLegacyGeometry && !sawRoutingEvidence) {
    assessmentReasons.add(
      providerFailed ? "road_condition_provider_unavailable" : "missing_current_evidence",
    );
  }
  return {
    points,
    polygons,
    localAccessLines,
    hardLines,
    legacyLocalAccess,
    roadConditionImpact: {
      availability,
      evaluatedAt: evaluatedAt.toISOString(),
      validUntil,
      reasons: [...assessmentReasons],
    },
  };
}
