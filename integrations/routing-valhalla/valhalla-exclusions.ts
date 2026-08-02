/**
 * Request-side safety limits for Valhalla exclusion geometry.
 *
 * The road-conditions feed can contain very detailed polygons and long
 * closure lines. Valhalla rejects an over-sized exclusion request with HTTP
 * 400, so this sanitizer lives at the adapter boundary. That also protects
 * callers such as the EV planner that construct RoutingOptions directly.
 */

import type { LngLat } from "@openmapx/core";
import { RoutingProviderError } from "@openmapx/integration-framework";

export type { LngLat } from "@openmapx/core";

/** Stay below Valhalla's default max_exclude_locations of 50. */
export const MAX_VALHALLA_EXCLUDE_LOCATIONS = 45;
/** Conservative cap on the number of polygon rings in one request. */
export const MAX_VALHALLA_EXCLUDE_POLYGONS = 256;
/** Stay below Valhalla's default max_exclude_polygons_length of 10,000. */
export const MAX_VALHALLA_POLYGON_VERTICES = 9_000;
/** Keep a single detailed closure from consuming the whole polygon budget. */
export const MAX_VALHALLA_POLYGON_VERTICES_PER_RING = 512;

const METRES_PER_DEGREE = 111_320;

export class ValhallaExclusionError extends RoutingProviderError {
  constructor(message: string) {
    super("unsupported-exclusions", message);
    this.name = "ValhallaExclusionError";
  }
}

export interface ExclusionSanitizationStats {
  inputPointCount: number;
  outputPointCount: number;
  pointsSubsampled: boolean;
  inputPolygonCount: number;
  outputPolygonCount: number;
  inputPolygonVertexCount: number;
  outputPolygonVertexCount: number;
  polygonsSimplified: number;
}

export interface SanitizedValhallaExclusions {
  points: LngLat[];
  polygons: LngLat[][];
  stats: ExclusionSanitizationStats;
}

function samePoint(a: LngLat, b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function validPoint(point: LngLat, label: string): LngLat {
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    point[0] < -180 ||
    point[0] > 180 ||
    point[1] < -90 ||
    point[1] > 90
  ) {
    throw new ValhallaExclusionError(`Invalid ${label} coordinate`);
  }
  return [point[0], point[1]];
}

function subsampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const stride = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(items[Math.floor(i * stride)] as T);
  }
  return out;
}

/** Remove consecutive duplicate vertices and close a GeoJSON outer ring. */
function normalizeRing(raw: LngLat[], index: number): LngLat[] {
  if (!Array.isArray(raw)) {
    throw new ValhallaExclusionError(`Invalid exclusion polygon ${index}`);
  }

  const cleaned: LngLat[] = [];
  for (const [pointIndex, point] of raw.entries()) {
    const normalized = validPoint(point, `exclusion polygon ${index} vertex ${pointIndex}`);
    if (!cleaned.at(-1) || !samePoint(cleaned.at(-1) as LngLat, normalized)) {
      cleaned.push(normalized);
    }
  }

  if (cleaned.length > 1 && samePoint(cleaned[0] as LngLat, cleaned.at(-1) as LngLat)) {
    cleaned.pop();
  }
  if (cleaned.length < 3) {
    throw new ValhallaExclusionError(`Exclusion polygon ${index} has fewer than three vertices`);
  }

  const first = cleaned[0] as LngLat;
  return [...cleaned, first];
}

function project(point: LngLat, referenceLatitude: number): [number, number] {
  const longitudeScale = METRES_PER_DEGREE * Math.cos((referenceLatitude * Math.PI) / 180);
  return [point[0] * longitudeScale, point[1] * METRES_PER_DEGREE];
}

function perpendicularDistance(point: LngLat, start: LngLat, end: LngLat, lat: number): number {
  const p = project(point, lat);
  const a = project(start, lat);
  const b = project(end, lat);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker simplification in a local metre projection. */
function simplifyOpenRing(points: LngLat[], toleranceMetres: number): LngLat[] {
  if (points.length <= 2) return points;

  const referenceLatitude = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const toleranceSquared = toleranceMetres * toleranceMetres;

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop() as [number, number];
    let furthestIndex = -1;
    let furthestDistanceSquared = toleranceSquared;
    const start = points[startIndex] as LngLat;
    const end = points[endIndex] as LngLat;

    for (let i = startIndex + 1; i < endIndex; i++) {
      const distance = perpendicularDistance(points[i] as LngLat, start, end, referenceLatitude);
      if (distance * distance > furthestDistanceSquared) {
        furthestIndex = i;
        furthestDistanceSquared = distance * distance;
      }
    }

    if (furthestIndex >= 0) {
      keep[furthestIndex] = 1;
      stack.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
    }
  }

  return points.filter((_point, index) => keep[index] === 1);
}

function subsampleOpenRing(points: LngLat[], maxVertices: number): LngLat[] {
  const maxOpenVertices = Math.max(3, maxVertices - 1);
  if (points.length <= maxOpenVertices) return points;

  const out: LngLat[] = [];
  for (let i = 0; i < maxOpenVertices; i++) {
    const index = Math.round((i * (points.length - 1)) / (maxOpenVertices - 1));
    out.push(points[index] as LngLat);
  }
  return out;
}

/** Simplify a closed ring while keeping it valid and preserving vertex order. */
function simplifyRing(ring: LngLat[], maxVertices: number): LngLat[] {
  if (ring.length <= maxVertices) return ring;

  const open = ring.slice(0, -1);
  let tolerance = 1;
  let simplified = open;
  for (let attempt = 0; attempt < 24; attempt++) {
    simplified = simplifyOpenRing(open, tolerance);
    if (simplified.length + 1 <= maxVertices) break;
    tolerance *= 2;
  }

  if (simplified.length + 1 > maxVertices) {
    simplified = subsampleOpenRing(simplified, maxVertices);
  }
  if (simplified.length < 3) {
    simplified = subsampleOpenRing(open, maxVertices);
  }

  const first = simplified[0] as LngLat;
  return [...simplified, first];
}

function capPolygonBudget(polygons: LngLat[][]): LngLat[][] {
  if (polygons.length > MAX_VALHALLA_EXCLUDE_POLYGONS) {
    throw new ValhallaExclusionError(
      `Valhalla exclusion request contains ${polygons.length} polygons; maximum safe count is ${MAX_VALHALLA_EXCLUDE_POLYGONS}`,
    );
  }

  const minimumVertices = polygons.length * 4;
  if (minimumVertices > MAX_VALHALLA_POLYGON_VERTICES) {
    throw new ValhallaExclusionError(
      `Valhalla exclusion request contains too many polygon rings to fit the ${MAX_VALHALLA_POLYGON_VERTICES}-vertex safety budget`,
    );
  }

  const perRing = polygons.map((polygon) =>
    simplifyRing(polygon, MAX_VALHALLA_POLYGON_VERTICES_PER_RING),
  );
  const currentVertices = perRing.reduce((sum, polygon) => sum + polygon.length, 0);
  if (currentVertices <= MAX_VALHALLA_POLYGON_VERTICES) return perRing;

  const availableExtra = MAX_VALHALLA_POLYGON_VERTICES - minimumVertices;
  const reducibleVertices = perRing.reduce(
    (sum, polygon) => sum + Math.max(0, polygon.length - 4),
    0,
  );
  let assignedExtra = 0;

  return perRing.map((polygon, index) => {
    const reducible = Math.max(0, polygon.length - 4);
    const extra =
      index === perRing.length - 1
        ? Math.max(0, availableExtra - assignedExtra)
        : Math.floor((availableExtra * reducible) / Math.max(1, reducibleVertices));
    assignedExtra += Math.min(reducible, extra);
    return simplifyRing(polygon, Math.min(polygon.length, 4 + Math.min(reducible, extra)));
  });
}

export function sanitizeValhallaExclusions(input: {
  points?: LngLat[];
  polygons?: LngLat[][];
}): SanitizedValhallaExclusions {
  const rawPoints = input.points ?? [];
  const points = rawPoints.map((point, index) => validPoint(point, `exclusion point ${index}`));
  const boundedPoints = subsampleEvenly(points, MAX_VALHALLA_EXCLUDE_LOCATIONS);

  const rawPolygons = input.polygons ?? [];
  const polygons = rawPolygons.map((ring, index) => normalizeRing(ring, index));
  const boundedPolygons = capPolygonBudget(polygons);

  return {
    points: boundedPoints,
    polygons: boundedPolygons,
    stats: {
      inputPointCount: points.length,
      outputPointCount: boundedPoints.length,
      pointsSubsampled: boundedPoints.length < points.length,
      inputPolygonCount: polygons.length,
      outputPolygonCount: boundedPolygons.length,
      inputPolygonVertexCount: polygons.reduce((sum, polygon) => sum + polygon.length, 0),
      outputPolygonVertexCount: boundedPolygons.reduce((sum, polygon) => sum + polygon.length, 0),
      polygonsSimplified: boundedPolygons.filter(
        (polygon, index) => polygon.length < (polygons[index]?.length ?? 0),
      ).length,
    },
  };
}
