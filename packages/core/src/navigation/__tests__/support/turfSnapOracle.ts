import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { LngLat } from "../../../types/geometry";
import type { SnapResult } from "../../types";

/**
 * Numerical reference for the prepared route matcher: projects a raw GPS fix
 * onto a route polyline with Turf, scanning the whole line on every call, and
 * returns the snapped point, the distance along the line and the perpendicular
 * deviation. All distances in meters. Production code uses the matcher; tests
 * compare it against this.
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
