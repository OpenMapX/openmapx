import type { Geometry, Position } from "geojson";
import type { LngLat } from "../types/geometry";
import { itemAt } from "../utils/itemAt";
import { type PreparedRouteMatcher, snapPreparedRoute } from "./routeMatcher";

/**
 * How far beside the route the map keeps showing road conditions during navigation:
 * the route itself, the roads next to it and the junctions you might divert through,
 * but not the whole city around you.
 */
export const ROUTE_CORRIDOR_METERS = 1000;

/** Vertices checked per geometry; a geometry with more is thinned evenly. */
const MAX_VERTICES = 1000;
/** Interior points added along segments per geometry, whatever its length. */
const MAX_INTERIOR = 400;
/** Areas, and vertices per area, tested for containing the route. */
const MAX_RINGS = 32;
const MAX_RING_VERTICES = 5000;
/** Route vertices tested against an area that might enclose the route. */
const MAX_ROUTE_PROBES = 64;
const METERS_PER_DEGREE = 111_320;

type Parts = { points: Position[]; lines: Position[][]; rings: Position[][] };

/** Appends without spreading, so a huge coordinate array cannot overflow the call stack. */
function append<T>(into: T[], items: T[]): void {
  for (const item of items) into.push(item);
}

function collect(geometry: Geometry, parts: Parts): Parts {
  switch (geometry.type) {
    case "Point":
      parts.points.push(geometry.coordinates);
      break;
    case "MultiPoint":
      append(parts.points, geometry.coordinates);
      break;
    case "LineString":
      parts.lines.push(geometry.coordinates);
      break;
    case "MultiLineString":
      append(parts.lines, geometry.coordinates);
      break;
    case "Polygon":
      append(parts.lines, geometry.coordinates);
      append(parts.rings, geometry.coordinates);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        append(parts.lines, polygon);
        append(parts.rings, polygon);
      }
      break;
    case "GeometryCollection":
      for (const child of geometry.geometries) collect(child, parts);
      break;
  }
  return parts;
}

/** The usable WGS84 positions as pairs; feed data outside these ranges is ignored, not sampled. */
function validPairs(positions: Position[]): LngLat[] {
  const pairs: LngLat[] = [];
  for (const [lng, lat] of positions) {
    if (
      lng !== undefined &&
      lat !== undefined &&
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      Math.abs(lng) <= 180 &&
      Math.abs(lat) <= 90
    )
      pairs.push([lng, lat]);
  }
  return pairs;
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => itemAt(items, Math.floor(i * step)));
}

/** Planar metres between two positions; enough to space samples along a segment. */
function metres(a: LngLat, b: LngLat): number {
  const kx = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * METERS_PER_DEGREE;
}

/**
 * Sample points: the vertices plus interior points along each segment, spaced at most
 * one corridor apart so a line crossing the route has a sample within it. The spacing
 * widens for very long geometry so the total stays bounded before any is generated.
 */
function samples(parts: Parts, corridorMeters: number): LngLat[] {
  // Each line keeps its share of the vertex budget (at least its two ends); a geometry
  // of countless short lines is thinned to as many lines as that budget allows.
  const kept = thin(parts.lines, MAX_VERTICES / 2);
  const total = kept.reduce((n, line) => n + line.length, 0);
  const lines = kept.map((line) =>
    thin(validPairs(line), Math.max(2, Math.floor((MAX_VERTICES * line.length) / total))),
  );
  const out: LngLat[] = thin(validPairs(parts.points), MAX_VERTICES);
  let length = 0;
  for (const line of lines)
    for (let i = 1; i < line.length; i++) length += metres(itemAt(line, i - 1), itemAt(line, i));
  const spacing = Math.max(corridorMeters, length / MAX_INTERIOR);
  for (const line of lines) {
    for (const [i, a] of line.entries()) {
      out.push(a);
      const b = line[i + 1];
      if (!b) continue;
      const steps = Math.min(MAX_INTERIOR, Math.floor(metres(a, b) / spacing));
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return out;
}

function inRing(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = itemAt(ring, i);
    const [xj, yj] = itemAt(ring, j);
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Whether any part of a geometry lies within `corridorMeters` of the route: a point or
 * line beside it, a line crossing it, or an area containing it. Used to keep the
 * road-conditions overlay to what matters for the trip while navigating, on the phone
 * and the Android Auto car map alike.
 */
export function isNearRoute(
  geometry: Geometry | null | undefined,
  route: PreparedRouteMatcher,
  corridorMeters: number = ROUTE_CORRIDOR_METERS,
): boolean {
  if (!geometry) return false;
  const parts = collect(geometry, { points: [], lines: [], rings: [] });
  for (const p of samples(parts, corridorMeters)) {
    const snap = snapPreparedRoute(route, p);
    if (snap.segmentIndex >= 0 && snap.deviationMeters <= corridorMeters) return true;
  }
  // An area the route runs through, with every edge far from it.
  const outer = parts.rings
    .flatMap((ring) => {
      if (ring.length < 4 || ring.length > MAX_RING_VERTICES) return [];
      const pairs = validPairs(ring);
      return pairs.length === ring.length ? [pairs] : [];
    })
    .slice(0, MAX_RINGS);
  if (outer.length === 0) return false;
  const step = Math.max(1, Math.ceil(route.geometry.length / MAX_ROUTE_PROBES));
  for (let i = 0; i < route.geometry.length; i += step) {
    const vertex = route.geometry[i];
    if (vertex && outer.some((ring) => inRing(vertex, ring))) return true;
  }
  return false;
}
