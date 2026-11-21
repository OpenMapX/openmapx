import { fromWebMercator } from "../mercator.js";
import type { IsochroneLattice } from "./lattice.js";

type Point = [number, number];

function signedArea(ring: readonly Point[]): number {
  let sum = 0;
  let previous: Point | undefined;
  for (const point of ring) {
    if (previous) sum += previous[0] * point[1] - point[0] * previous[1];
    previous = point;
  }
  return sum / 2;
}

function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let contained = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i += 1) {
    const current = ring[i];
    const previous = ring[j];
    if (!current || !previous) continue;
    const [xi, yi] = current;
    const [xj, yj] = previous;
    const straddles = yi > point[1] !== yj > point[1];
    if (straddles && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      contained = !contained;
    }
  }
  return contained;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
}

function selfIntersects(ring: readonly Point[]): boolean {
  for (let i = 0; i < ring.length - 1; i += 1) {
    for (let j = i + 2; j < ring.length - 1; j += 1) {
      // The first and last segments legitimately share the closing vertex.
      if (i === 0 && j === ring.length - 2) continue;
      const a = ring[i];
      const b = ring[i + 1];
      const c = ring[j];
      const d = ring[j + 1];
      if (a && b && c && d && segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function douglasPeucker(points: readonly Point[], tolerance: number): Point[] {
  const start = points[0];
  const end = points.at(-1);
  if (points.length < 3 || !start || !end) return [...points];
  let maxDistance = -1;
  let index = 0;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const span = Math.hypot(dx, dy);
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    if (!point) continue;
    const distance =
      span === 0
        ? Math.hypot(point[0] - start[0], point[1] - start[1])
        : Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / span;
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [start, end];
  return [
    ...douglasPeucker(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...douglasPeucker(points.slice(index), tolerance),
  ];
}

/**
 * Douglas-Peucker a closed ring, reverting whenever the result would be
 * degenerate or self-intersecting.
 *
 * Simplification must never claim more precision than the lattice supports, so
 * callers pass a tolerance derived from the spacing.
 */
export function simplifyRing(ring: readonly Point[], tolerance: number): Point[] {
  if (ring.length <= 4) return [...ring];
  const simplified = douglasPeucker(ring, tolerance);
  if (simplified.length < 4) return [...ring];
  const first = simplified[0];
  const last = simplified.at(-1);
  if (!first || !last) return [...ring];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push([first[0], first[1]]);
  if (simplified.length < 4) return [...ring];
  if (selfIntersects(simplified)) return [...ring];
  return simplified;
}

function orient(ring: Point[], counterClockwise: boolean): Point[] {
  const isCounterClockwise = signedArea(ring) > 0;
  return isCounterClockwise === counterClockwise ? ring : [...ring].reverse();
}

/**
 * Assemble traced rings into an RFC 7946 geometry.
 *
 * Rings are classified by containment depth: even depth is an exterior, odd
 * depth is a hole in the smallest ring that contains it. Exteriors are wound
 * counter-clockwise and holes clockwise, then coordinates are unprojected.
 */
export function ringsToGeometry(
  rings: readonly Point[][],
  lattice: IsochroneLattice,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (rings.length === 0) return null;

  const tolerance = lattice.spacing * 0.25;
  const simplified = rings
    .map((ring) => simplifyRing(ring, tolerance))
    .filter((ring) => ring.length >= 4);
  if (simplified.length === 0) return null;

  // Largest first, so a ring's containing parent is always already indexed.
  const ordered = [...simplified].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  const parentOf = new Map<number, number>();
  for (const [child, childRing] of ordered.entries()) {
    const [start] = childRing;
    if (!start) continue;
    for (const [parent, parentRing] of ordered.entries()) {
      if (parent >= child) break;
      if (pointInRing(start, parentRing)) parentOf.set(child, parent);
    }
  }

  const depthOf = (index: number): number => {
    let depth = 0;
    let cursor = parentOf.get(index);
    while (cursor !== undefined) {
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    return depth;
  };

  const polygons: Point[][][] = [];
  const exteriorSlot = new Map<number, number>();
  for (const [index, ring] of ordered.entries()) {
    if (depthOf(index) % 2 === 0) {
      exteriorSlot.set(index, polygons.length);
      polygons.push([orient(ring, true)]);
    }
  }
  for (const [index, ring] of ordered.entries()) {
    if (depthOf(index) % 2 === 0) continue;
    const parent = parentOf.get(index);
    const slot = parent === undefined ? undefined : exteriorSlot.get(parent);
    if (slot === undefined) continue;
    polygons[slot]?.push(orient(ring, false));
  }

  const unproject = (ring: Point[]): number[][] =>
    ring.map(([x, y]) => {
      const [lng, lat] = fromWebMercator(x, y);
      return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
    });

  const projected = polygons.map((polygon) => polygon.map(unproject));
  const [only] = projected;
  if (projected.length === 1 && only) return { type: "Polygon", coordinates: only };
  return { type: "MultiPolygon", coordinates: projected };
}
