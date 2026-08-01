import type { LngLat } from "../types/geometry";
import type { Route } from "../types/routing";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { snapToRoute } from "./snap";

export interface FasterRouteOptions {
  /** Lateral metres a candidate may stray before it counts as leaving the corridor. */
  corridorToleranceMeters: number;
  /** Minimum absolute saving, seconds. */
  minSavedSeconds: number;
  /** Minimum saving as a fraction of the remaining trip. */
  minSavedRatio: number;
  /** Minimum seconds of driving between the driver and the divergence point. */
  minLeadSeconds: number;
  /** Current ground speed, m/s, converting lead time into lead distance. */
  speedMps: number;
}

export interface FasterRouteCandidate {
  route: Route;
  savedSeconds: number;
  /** Distance ahead of the driver at which this candidate leaves the current route. */
  divergenceMeters: number;
}

export interface FasterRouteEvaluation {
  /** Fresh remaining-seconds for the corridor already being driven, when one matched. */
  refreshedRemainingSeconds: number | null;
  /** Best qualifying divergent candidate, or null. */
  faster: FasterRouteCandidate | null;
}

export const FASTER_ROUTE_DEFAULTS: Omit<FasterRouteOptions, "speedMps"> = {
  corridorToleranceMeters: 60,
  minSavedSeconds: 300,
  minSavedRatio: 0.15,
  minLeadSeconds: 60,
};

/** A stopped driver still needs enough room to reach a possible divergence. */
const MIN_LEAD_METERS = 200;

/**
 * Return the current route's remaining corridor with the driver's exact
 * interpolated position as its first point.
 */
function remainingGeometry(geometry: LngLat[], alongMeters: number): LngLat[] {
  if (geometry.length < 2) return geometry;
  const cum = cumulativeDistances(geometry);
  const here = positionAt(geometry, cum, alongMeters).point;
  const tail = geometry.filter((_, i) => cum[i] > alongMeters);
  return tail.length > 0 ? [here, ...tail] : [here, geometry[geometry.length - 1]];
}

/**
 * Find the first candidate vertex outside the current corridor. The distance
 * is measured along the candidate, which starts at the driver's position.
 */
function divergenceAlong(
  candidate: LngLat[],
  corridor: LngLat[],
  toleranceMeters: number,
): number | null {
  if (candidate.length < 2 || corridor.length < 2) return null;
  const cum = cumulativeDistances(candidate);
  for (let i = 0; i < candidate.length; i++) {
    const { deviationMeters } = snapToRoute(corridor, candidate[i]);
    if (deviationMeters > toleranceMeters) return cum[i];
  }
  return null;
}

/**
 * Decide whether a freshly planned candidate is worth switching to.
 *
 * A same-corridor candidate supplies a fresh baseline for the route already
 * being driven. Divergent candidates are compared with that baseline, or with
 * the ETA currently shown when no corridor match was returned.
 */
export function evaluateFasterRoute(
  current: Route,
  alongMeters: number,
  remainingSeconds: number,
  candidates: Route[],
  opts: FasterRouteOptions,
): FasterRouteEvaluation {
  const corridor = remainingGeometry(current.geometry, alongMeters);

  let refreshedRemainingSeconds: number | null = null;
  const divergent: FasterRouteCandidate[] = [];

  for (const route of candidates) {
    const divergence = divergenceAlong(route.geometry, corridor, opts.corridorToleranceMeters);
    if (divergence === null) {
      refreshedRemainingSeconds =
        refreshedRemainingSeconds === null
          ? route.duration
          : Math.min(refreshedRemainingSeconds, route.duration);
      continue;
    }
    divergent.push({ route, savedSeconds: 0, divergenceMeters: divergence });
  }

  const baseline = refreshedRemainingSeconds ?? remainingSeconds;
  const leadMeters = Math.max(MIN_LEAD_METERS, opts.speedMps * opts.minLeadSeconds);

  let best: FasterRouteCandidate | null = null;
  for (const candidate of divergent) {
    if (candidate.divergenceMeters < leadMeters) continue;
    const savedSeconds = baseline - candidate.route.duration;
    if (savedSeconds < opts.minSavedSeconds) continue;
    if (baseline <= 0 || savedSeconds / baseline < opts.minSavedRatio) continue;
    if (best === null || candidate.route.duration < best.route.duration) {
      best = { ...candidate, savedSeconds };
    }
  }

  return { refreshedRemainingSeconds, faster: best };
}
