import type { Geometry, Position } from "geojson";
import type { LngLat } from "../types/geometry";
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

/** A usable WGS84 position; feed data outside these ranges is ignored, not sampled. */
const valid = (p: Position | undefined): p is Position =>
  !!p &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0] as number) <= 180 &&
  Math.abs(p[1] as number) <= 90;

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)] as T);
}

/** Planar metres between two positions; enough to space samples along a segment. */
function metres(a: Position, b: Position): number {
  const kx = Math.cos((((a[1] as number) + (b[1] as number)) / 2) * (Math.PI / 180));
  return (
    Math.hypot(((b[0] as number) - (a[0] as number)) * kx, (b[1] as number) - (a[1] as number)) *
    METERS_PER_DEGREE
  );
}

/**
 * Sample points: the vertices plus interior points along each segment, spaced at most
 * one corridor apart so a line crossing the route has a sample within it. The spacing
 * widens for very long geometry so the total stays bounded before any is generated.
 */
function samples(parts: Parts, corridorMeters: number): Position[] {
  // Each line keeps its share of the vertex budget (at least its two ends); a geometry
  // of countless short lines is thinned to as many lines as that budget allows.
  const kept = thin(parts.lines, MAX_VERTICES / 2);
  const total = kept.reduce((n, line) => n + line.length, 0);
  const lines = kept.map((line) =>
    thin(line.filter(valid), Math.max(2, Math.floor((MAX_VERTICES * line.length) / total))),
  );
  const out: Position[] = thin(parts.points.filter(valid), MAX_VERTICES);
  let length = 0;
  for (const line of lines)
    for (let i = 1; i < line.length; i++)
      length += metres(line[i - 1] as Position, line[i] as Position);
  const spacing = Math.max(corridorMeters, length / MAX_INTERIOR);
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i] as Position;
      out.push(a);
      const b = line[i + 1];
      if (!b) continue;
      const steps = Math.min(MAX_INTERIOR, Math.floor(metres(a, b) / spacing));
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1);
        out.push([
          (a[0] as number) + ((b[0] as number) - (a[0] as number)) * t,
          (a[1] as number) + ((b[1] as number) - (a[1] as number)) * t,
        ]);
      }
    }
  }
  return out;
}

function inRing(point: LngLat, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
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
    const snap = snapPreparedRoute(route, [p[0], p[1]] as LngLat);
    if (snap.segmentIndex >= 0 && snap.deviationMeters <= corridorMeters) return true;
  }
  // An area the route runs through, with every edge far from it.
  const outer = parts.rings
    .filter((ring) => ring.length >= 4 && ring.length <= MAX_RING_VERTICES && ring.every(valid))
    .slice(0, MAX_RINGS);
  if (outer.length === 0) return false;
  const step = Math.max(1, Math.ceil(route.geometry.length / MAX_ROUTE_PROBES));
  for (let i = 0; i < route.geometry.length; i += step) {
    const vertex = route.geometry[i];
    if (vertex && outer.some((ring) => inRing(vertex, ring))) return true;
  }
  return false;
}
