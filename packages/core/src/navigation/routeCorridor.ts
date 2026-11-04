import type { Geometry, Position } from "geojson";
import type { LngLat } from "../types/geometry";
import { type PreparedRouteMatcher, snapPreparedRoute } from "./routeMatcher";

/**
 * How far beside the route the map keeps showing road conditions during navigation:
 * the route itself, the roads next to it and the junctions you might divert through,
 * but not the whole city around you.
 */
export const ROUTE_CORRIDOR_METERS = 1000;

/** Vertices checked per geometry; a long line is sampled evenly rather than in full. */
const MAX_SAMPLES = 24;

function positions(geometry: Geometry): Position[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
    case "GeometryCollection":
      return geometry.geometries.flatMap(positions);
  }
}

/**
 * Whether any part of a geometry lies within `corridorMeters` of the route. Used to
 * keep the road-conditions overlay to what matters for the trip while navigating, on
 * the phone and the Android Auto car map alike.
 */
export function isNearRoute(
  geometry: Geometry | null | undefined,
  route: PreparedRouteMatcher,
  corridorMeters: number = ROUTE_CORRIDOR_METERS,
): boolean {
  if (!geometry) return false;
  const all = positions(geometry).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (all.length === 0) return false;
  const step = Math.max(1, Math.ceil(all.length / MAX_SAMPLES));
  for (let i = 0; i < all.length; i += step) {
    const p = all[i];
    if (!p) continue;
    const snap = snapPreparedRoute(route, [p[0], p[1]] as LngLat);
    if (snap.segmentIndex >= 0 && snap.deviationMeters <= corridorMeters) return true;
  }
  // The last vertex too, so a line ending on the route is never sampled past.
  const last = all[all.length - 1];
  if (!last) return false;
  const snap = snapPreparedRoute(route, [last[0], last[1]] as LngLat);
  return snap.segmentIndex >= 0 && snap.deviationMeters <= corridorMeters;
}
