import type { BBox } from "@openmapx/core";
import type { IntegrationContext, RoadConditionsProvider } from "@openmapx/integration-framework";

export type LngLat = [number, number];

export interface ClosureExclusions {
  points: LngLat[];
  polygons: LngLat[][];
}

/** Severity threshold: only events at this level or above are treated as exclusions. */
const CLOSURE_TYPES = new Set(["road_closure", "lane_closure"]);
const CRITICAL_SEVERITY = "critical";

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
): void {
  switch (geometry.type) {
    case "Point": {
      const p = toLngLat(geometry.coordinates as number[]);
      if (p) points.push(p);
      break;
    }
    case "LineString": {
      points.push(...sampleCoords(geometry.coordinates as number[][]));
      break;
    }
    case "MultiLineString": {
      for (const line of geometry.coordinates as number[][][]) {
        points.push(...sampleCoords(line));
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
      geometryToExclusions(event.geometry, points, polygons);
    }
  }

  return { points, polygons };
}
