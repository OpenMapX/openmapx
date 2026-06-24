import type { BBox } from "@openmapx/core";
import { haversineDistance } from "@openmapx/core";
import type { IntegrationContext, RoadConditionsProvider } from "@openmapx/integration-framework";

export type LngLat = [number, number];

export interface ClosureExclusions {
  points: LngLat[];
  polygons: LngLat[][];
}

/** Severity threshold: only events at this level or above are treated as exclusions. */
const CLOSURE_TYPES = new Set(["road_closure", "lane_closure"]);
const CRITICAL_SEVERITY = "critical";

/**
 * Maximum spacing (metres) between consecutive exclusion points on a densified
 * closure line. Keeps the gap small enough that Valhalla blocks the full segment
 * rather than routing through the space between sparse vertices.
 */
const MAX_EXCLUSION_SPACING_M = 45;

/**
 * Hard cap on exclusion points emitted per single closure geometry. Prevents a
 * single very-long LineString from flooding the Valhalla request body.
 */
const MAX_EXCLUSION_POINTS_PER_CLOSURE = 300;

/**
 * Hard cap on the TOTAL number of exclusion points across all closures in one
 * request. Valhalla rejects more than 50 `exclude_locations` outright
 * (HTTP 400, "Exceeded max avoid locations: 50"), which would fail the whole
 * route — so we stay safely below that ceiling and subsample if needed. 45
 * still blocks a closure densely enough to force a detour (verified against the
 * A565 Bonn-Nord bridge closure).
 */
const MAX_TOTAL_EXCLUSION_POINTS = 45;

/**
 * Evenly subsample `points` down to at most `max`, preserving geographic spread
 * (and the first vertex). Returns the input unchanged when already within `max`.
 */
function subsampleEvenly(points: LngLat[], max: number): LngLat[] {
  if (points.length <= max) return points;
  const stride = points.length / max;
  const out: LngLat[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * stride)] as LngLat);
  return out;
}

function isClosure(type: string, severity: string): boolean {
  // The severity branch is defensive: some providers may not filter by `types`
  // and instead return critical-severity events of any type (e.g. "accident"),
  // so we treat those as blockages too rather than silently ignoring them.
  return CLOSURE_TYPES.has(type) || severity === CRITICAL_SEVERITY;
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

function geometryToExclusions(
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
    default:
      break;
  }
}

/**
 * Collect active road closures from all registered road-conditions providers
 * and convert them into Valhalla-compatible exclusion geometry.
 *
 * The routing integration depends only on the `road-conditions` capability
 * contract — never on `@openconditions/*` packages or the conditions.observations
 * table directly.
 */
export async function activeClosuresForBbox(
  ctx: IntegrationContext,
  bbox: BBox,
): Promise<ClosureExclusions> {
  const integrations = ctx.getIntegrationsByDomain("road-conditions");
  if (integrations.length === 0) return { points: [], polygons: [] };

  const providers = integrations.flatMap(
    (i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[],
  );
  if (providers.length === 0) return { points: [], polygons: [] };

  const settled = await Promise.allSettled(
    providers.map((p) =>
      p.getEvents(bbox, {
        types: ["road_closure", "lane_closure"],
        minSeverity: "high",
      }),
    ),
  );

  const points: LngLat[] = [];
  const polygons: LngLat[][] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue;
    if (result.status === "rejected") {
      ctx.log.warn(
        `[routing/closures] road-conditions provider ${providers[i]?.id} failed`,
        result.reason,
      );
      continue;
    }
    for (const event of result.value) {
      if (!isClosure(event.type, event.severity)) continue;
      if (event.roadState === "open") continue;
      if (!event.geometry) continue;
      geometryToExclusions(event.geometry, points, polygons, ctx);
    }
  }

  if (points.length > MAX_TOTAL_EXCLUSION_POINTS) {
    const trimmed = subsampleEvenly(points, MAX_TOTAL_EXCLUSION_POINTS);
    ctx.log.warn(
      `[routing/closures] ${points.length} exclusion points exceed Valhalla's exclude_locations limit; subsampled to ${trimmed.length}`,
    );
    return { points: trimmed, polygons };
  }

  return { points, polygons };
}
