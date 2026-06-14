import type { LngLat } from "../types/geometry";
import { snapToRoute } from "./snap";
import type { RerouteOpts } from "./types";

/** Deviation change (m) below which a stationary fix is treated as GPS jitter. */
const DEAD_BAND_METERS = 0.5;

/**
 * Update the off-route score from a single fix. Off-route fixes accrue evidence
 * — more while moving (the deviation is meaningful) than while slow — and an
 * on-route fix clears it. A fix whose deviation barely changed while essentially
 * stationary is ignored, so GPS jitter at a standstill doesn't slowly trip a
 * reroute. `wrongDirection` (heading away from the route) adds an extra point so
 * a genuine wrong turn escalates faster than drifting off the line.
 */
export function updateOffRouteScore(
  prevScore: number,
  offRoute: boolean,
  moving: boolean,
  wrongDirection: boolean,
  deviation: number,
  lastDeviation: number | undefined,
): number {
  if (!offRoute) return 0;
  const stationaryJitter =
    !moving &&
    lastDeviation !== undefined &&
    Math.abs(deviation - lastDeviation) < DEAD_BAND_METERS;
  if (stationaryJitter) return prevScore;
  return prevScore + (moving ? 2 : 1) + (wrongDirection ? 1 : 0);
}

/**
 * Decide whether to trigger a reroute: the accrued off-route score has reached
 * the threshold and the (growing) back-off window since the last reroute has
 * elapsed.
 */
export function shouldReroute(
  score: number,
  lastRerouteAtMs: number | null,
  backoffMs: number,
  nowMs: number,
  opts: RerouteOpts,
): boolean {
  if (score < opts.scoreThreshold) return false;
  if (lastRerouteAtMs !== null && nowMs - lastRerouteAtMs < backoffMs) return false;
  return true;
}

/**
 * Build the waypoint list for a reroute from the current position. The origin is
 * replaced by `from` (the snapped current location); intermediate stops already
 * behind us along the route are dropped so a reroute doesn't send the driver
 * back to a stop they've passed; the final destination is always kept. Each
 * remaining stop is located by projecting it onto the route and comparing its
 * arc-length to how far we've travelled (`alongMeters`).
 */
export function remainingWaypoints(
  routeGeometry: LngLat[],
  destinationWaypoints: LngLat[],
  from: LngLat,
  alongMeters: number,
): LngLat[] {
  // Origin + destination only: nothing to prune, just re-anchor the start.
  if (destinationWaypoints.length <= 2) {
    return [from, ...destinationWaypoints.slice(1)];
  }
  const lastIdx = destinationWaypoints.length - 1;
  const kept: LngLat[] = [];
  for (let i = 1; i < destinationWaypoints.length; i++) {
    if (i === lastIdx) {
      kept.push(destinationWaypoints[i]); // always keep the final destination
      continue;
    }
    const wpAlong = snapToRoute(routeGeometry, destinationWaypoints[i]).alongMeters;
    if (wpAlong > alongMeters) kept.push(destinationWaypoints[i]); // still ahead
  }
  return [from, ...kept];
}
