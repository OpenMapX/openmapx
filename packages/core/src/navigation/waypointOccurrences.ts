import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { asRouteMatcher, type RouteMatcherInput, snapPreparedRoute } from "./routeMatcher";

/** Project onto the future suffix, rather than an earlier visit to the same road. */
export function projectWaypointAfter(
  route: RouteMatcherInput,
  target: LngLat,
  fromAlongMeters: number,
) {
  const matcher = asRouteMatcher(route);
  if (fromAlongMeters <= 0) return snapPreparedRoute(matcher, target);
  const geometry = matcher.geometry;
  const cumulative = cumulativeDistances(geometry);
  const total = cumulative.at(-1) ?? 0;
  const from = Math.min(fromAlongMeters, total);
  const start = positionAt(geometry, cumulative, from).point;
  const suffix = [start, ...geometry.filter((_, i) => cumulative[i] > from)];
  if (suffix.length < 2)
    return {
      snapped: start,
      alongMeters: total,
      deviationMeters: haversineDistance(start, target),
      segmentIndex: Math.max(0, geometry.length - 2),
    };
  const projected = snapPreparedRoute(asRouteMatcher(suffix), target);
  return { ...projected, alongMeters: from + projected.alongMeters };
}

export interface WaypointOccurrence {
  coordinates: LngLat;
  alongMeters: number;
  final: boolean;
}

/** Resolve waypoint occurrences in itinerary order, including on retraced roads. */
export function resolveWaypointOccurrences(
  route: RouteMatcherInput,
  waypoints: LngLat[],
  fromAlongMeters = 0,
): WaypointOccurrence[] {
  const matcher = asRouteMatcher(route);
  const geometry = matcher.geometry;
  const total = cumulativeDistances(geometry).at(-1) ?? 0;
  let cursor = fromAlongMeters;
  return waypoints.slice(1).map((coordinates, index) => {
    const final = index === waypoints.length - 2;
    cursor = final ? total : projectWaypointAfter(matcher, coordinates, cursor).alongMeters;
    return { coordinates, alongMeters: cursor, final };
  });
}
