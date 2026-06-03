import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { LngLat } from "../types/geometry";
import type { SnapResult } from "./types";

/**
 * Project a raw GPS fix onto a route polyline, returning the snapped point,
 * the distance traveled along the line to that point, and the perpendicular
 * deviation of the raw fix from the line. All distances in meters.
 */
export function snapToRoute(geometry: LngLat[], raw: LngLat): SnapResult {
  const snapped = nearestPointOnLine(lineString(geometry), point(raw), {
    units: "meters",
  });
  return {
    snapped: snapped.geometry.coordinates as LngLat,
    alongMeters: snapped.properties.location ?? 0,
    deviationMeters: snapped.properties.dist ?? 0,
    segmentIndex: snapped.properties.index ?? 0,
  };
}
