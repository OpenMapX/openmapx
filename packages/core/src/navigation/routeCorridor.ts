import type { Geometry, Position } from "geojson";
import type { LngLat } from "../types/geometry";
import { type PreparedRouteMatcher, snapPreparedRoute } from "./routeMatcher";

/**
 * How far beside the route the map keeps showing road conditions during navigation:
 * the route itself, the roads next to it and the junctions you might divert through,
 * but not the whole city around you.
 */
export const ROUTE_CORRIDOR_METERS = 1000;

/** Points checked per geometry; beyond this a long line is sampled more sparsely. */
const MAX_SAMPLES = 400;
/** Route vertices tested against an area that might enclose the route. */
const MAX_ROUTE_PROBES = 64;
const METERS_PER_DEGREE = 111_320;

type Parts = { points: Position[]; lines: Position[][]; rings: Position[][] };

function collect(geometry: Geometry, parts: Parts): Parts {
  switch (geometry.type) {
    case "Point":
      parts.points.push(geometry.coordinates);
      break;
    case "MultiPoint":
      parts.points.push(...geometry.coordinates);
      break;
    case "LineString":
      parts.lines.push(geometry.coordinates);
      break;
    case "MultiLineString":
      parts.lines.push(...geometry.coordinates);
      break;
    case "Polygon":
      parts.lines.push(...geometry.coordinates);
      parts.rings.push(...geometry.coordinates);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        parts.lines.push(...polygon);
        parts.rings.push(...polygon);
      }
      break;
    case "GeometryCollection":
      for (const child of geometry.geometries) collect(child, parts);
      break;
  }
  return parts;
}

const finite = (p: Position | undefined): p is Position =>
  !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Planar metres between two positions; enough to space samples along a segment. */
function metres(a: Position, b: Position): number {
  const kx = Math.cos((((a[1] ?? 0) + (b[1] ?? 0)) / 2) * (Math.PI / 180));
  return (
    Math.hypot(((b[0] ?? 0) - (a[0] ?? 0)) * kx, (b[1] ?? 0) - (a[1] ?? 0)) * METERS_PER_DEGREE
  );
}

/**
 * Sample points along every line: vertices plus interior points no further apart than
 * the corridor, so a line crossing the route always has a sample within the corridor.
 */
function samples(parts: Parts, spacing: number): Position[] {
  const out: Position[] = parts.points.filter(finite);
  for (const line of parts.lines) {
    const vertices = line.filter(finite);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i] as Position;
      out.push(a);
      const b = vertices[i + 1];
      if (!b) continue;
      const steps = Math.floor(metres(a, b) / spacing);
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
  let points = samples(parts, corridorMeters);
  if (points.length > MAX_SAMPLES) {
    // Very long geometry: coarser spacing keeps the cost bounded.
    const sparse = (corridorMeters * points.length) / MAX_SAMPLES;
    points = samples(parts, sparse);
  }
  for (const p of points) {
    const snap = snapPreparedRoute(route, [p[0], p[1]] as LngLat);
    if (snap.segmentIndex >= 0 && snap.deviationMeters <= corridorMeters) return true;
  }
  // An area the route runs through, with every edge far from it.
  const outer = parts.rings.filter((ring) => ring.length >= 4);
  if (outer.length === 0) return false;
  const step = Math.max(1, Math.ceil(route.geometry.length / MAX_ROUTE_PROBES));
  for (let i = 0; i < route.geometry.length; i += step) {
    const vertex = route.geometry[i];
    if (vertex && outer.some((ring) => inRing(vertex, ring))) return true;
  }
  return false;
}
