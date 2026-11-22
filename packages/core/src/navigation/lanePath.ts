import type { LngLat } from "../types/geometry";

/**
 * Where navigation draws the car and the manoeuvre arrow in the recommended
 * lane before a junction, as a sideways offset from the route line. Display
 * only: the route geometry, snapping, progress and off-route detection keep
 * the real route line.
 */
export interface LanePath {
  /** Along-route metres where the lane highlight begins; the offset eases in from here. */
  fromAlong: number;
  /** Along-route metres where the highlight ends at the junction; the offset tapers from here. */
  toAlong: number;
  /** Along-route metres where everything is back on the route line (past the turn). */
  rejoinAlong: number;
  /** Sideways distance to the lane centre, positive to the right of travel. */
  offsetMeters: number;
}

/** The offset eases in over this many metres, so the car slides into the lane. */
export const LANE_ENTRY_M = 15;

/** The sideways offset at `along`: in from the highlight start, out to the rejoin point. */
export function laneOffsetAt(along: number, path: LanePath): number {
  const { fromAlong, toAlong, rejoinAlong, offsetMeters } = path;
  if (offsetMeters === 0 || along <= fromAlong || along >= rejoinAlong) return 0;
  const entryEnd = fromAlong + Math.min(LANE_ENTRY_M, Math.max(toAlong - fromAlong, 1e-6));
  if (along < entryEnd) return (offsetMeters * (along - fromAlong)) / (entryEnd - fromAlong);
  if (along <= toAlong) return offsetMeters;
  return (offsetMeters * (rejoinAlong - along)) / Math.max(rejoinAlong - toAlong, 1e-6);
}

const EARTH_RADIUS_M = 6371008.8;

/** `point` moved `meters` sideways from `bearingDeg`, positive to the right. */
export function offsetLngLat(point: LngLat, bearingDeg: number, meters: number): LngLat {
  if (meters === 0) return point;
  const right = ((bearingDeg + 90) * Math.PI) / 180;
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const cos = Math.cos((point[1] * Math.PI) / 180);
  return [
    point[0] + (Math.sin(right) * meters) / (k * cos),
    point[1] + (Math.cos(right) * meters) / k,
  ];
}
