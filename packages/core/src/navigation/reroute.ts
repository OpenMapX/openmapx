import type { LngLat } from "../types/geometry";
import { asRouteMatcher, type RouteMatcherInput, snapPreparedRoute } from "./routeMatcher";
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
 * Decide whether to trigger a reroute because a new road closure has appeared
 * ahead on the active route. The `closureAhead` flag is true when at least one
 * closure whose id was not known at route-commit time is projected ahead of the
 * driver's current position. Reuses the same backoff/debounce as the off-route
 * reroute so both causes share a single cooldown — no extra churn.
 */
export function shouldRerouteForClosure(
  closureAhead: boolean,
  lastRerouteAtMs: number | null,
  backoffMs: number,
  nowMs: number,
): boolean {
  if (!closureAhead) return false;
  if (lastRerouteAtMs !== null && nowMs - lastRerouteAtMs < backoffMs) return false;
  return true;
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
 * arc-length to how far we've travelled (`alongMeters`). All stops share one
 * prepared index for the active route — the caller's, when it has one.
 */
/**
 * Drop reroute timestamps (ms) older than `windowMs` relative to `nowMs`, keeping
 * a rolling window for churn detection.
 */
export function pruneRerouteTimes(
  timestampsMs: number[],
  nowMs: number,
  windowMs: number,
): number[] {
  return timestampsMs.filter((t) => nowMs - t < windowMs);
}

/**
 * Reroute churn: at least `maxInWindow` reroutes within the rolling window
 * (`timestampsMs` must already be pruned to it). The engine reacts by imposing a
 * short cooldown so it stops re-rerouting onto fresh routes that immediately read
 * off-route (GPS noise, an awkward first maneuver) — breaking the loop.
 */
export function isReroutingTooOften(timestampsMs: number[], maxInWindow: number): boolean {
  return timestampsMs.length >= maxInWindow;
}

export function remainingWaypoints(
  route: RouteMatcherInput,
  destinationWaypoints: LngLat[],
  from: LngLat,
  alongMeters: number,
): LngLat[] {
  // Origin + destination only: nothing to prune, just re-anchor the start.
  if (destinationWaypoints.length <= 2) {
    return [from, ...destinationWaypoints.slice(1)];
  }
  const matcher = asRouteMatcher(route);
  const lastIdx = destinationWaypoints.length - 1;
  const kept: LngLat[] = [];
  for (let i = 1; i < destinationWaypoints.length; i++) {
    if (i === lastIdx) {
      kept.push(destinationWaypoints[i]); // always keep the final destination
      continue;
    }
    const wpAlong = snapPreparedRoute(matcher, destinationWaypoints[i]).alongMeters;
    if (wpAlong > alongMeters) kept.push(destinationWaypoints[i]); // still ahead
  }
  return [from, ...kept];
}
