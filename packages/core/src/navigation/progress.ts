import type { Route } from "../types/routing";
import { prepareManeuverPositions } from "./maneuverPosition";
import type { ProgressResult } from "./types";

/**
 * Map a distance traveled along the route to the current step, the distance to
 * the next maneuver, and the remaining distance/duration to the destination.
 * Step boundaries use the same ordered geometry occurrences as route snapping.
 *
 * `forcedStepIndex` overrides which step is treated as current — passed by the
 * step-advance gate so the displayed/announced step only advances once the
 * maneuver is completed, even though the snapped arc-length has crossed the
 * boundary. Distance/duration remaining stay geometric (gate-independent).
 */
export function computeProgress(
  route: Route,
  alongMeters: number,
  forcedStepIndex?: number,
): ProgressResult {
  const steps = route.steps;
  if (steps.length === 0) {
    // A route with geometry but no steps is a real shape — a limited
    // provider, a malformed response, or a restored offline session can all
    // produce `steps: []`. There is no step to index into, so
    // `currentStepIndex: 0` below is a compatibility value, not a claim that
    // step 0 exists. Distance/duration remaining are still reported honestly
    // off the route total, rather than hard-coded to 0 (which used to read as
    // an instant arrival). `total <= 0` or non-finite is a genuinely
    // zero-length or unusable route — nothing is left, and dividing by it
    // would produce NaN/Infinity.
    const total = route.distance;
    const usable = Number.isFinite(total) && total > 0;
    const along = usable ? Math.max(0, Math.min(alongMeters, total)) : 0;
    const distanceRemaining = usable ? Math.max(0, total - along) : 0;
    const durationRemaining =
      usable && Number.isFinite(route.duration) ? route.duration * (distanceRemaining / total) : 0;
    return {
      currentStepIndex: 0,
      distanceToNextManeuver: distanceRemaining,
      distanceRemaining,
      durationRemaining,
    };
  }
  const positions = prepareManeuverPositions(route);
  const total = positions.total;
  const along = Math.max(0, Math.min(alongMeters, total));
  let rawIdx = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    if (along <= positions.ends[i]) {
      rawIdx = i;
      break;
    }
  }
  const idx =
    forcedStepIndex != null ? Math.min(Math.max(forcedStepIndex, 0), steps.length - 1) : rawIdx;
  const distanceToNextManeuver = Math.max(0, positions.ends[idx] - along);
  const rawLength = positions.ends[rawIdx] - positions.starts[rawIdx];
  const fractionLeft =
    rawLength > 0 ? Math.min(1, Math.max(0, (positions.ends[rawIdx] - along) / rawLength)) : 0;
  // Convert the physical fraction back into provider travel-distance and ETA units.
  let distanceRemaining = steps[rawIdx].distance * fractionLeft;
  let durationRemaining = steps[rawIdx].duration * fractionLeft;
  for (let i = rawIdx + 1; i < steps.length; i++) {
    distanceRemaining += steps[i].distance;
    durationRemaining += steps[i].duration;
  }

  return { currentStepIndex: idx, distanceToNextManeuver, distanceRemaining, durationRemaining };
}

/**
 * Index of the maneuver to announce/display while driving a step.
 *
 * `computeProgress` reports `currentStepIndex` as the step you're driving ALONG
 * and `distanceToNextManeuver` as the distance to its END — i.e. to the maneuver
 * at the start of the *next* step. A route step's `instruction`/`maneuver`
 * describes the action at its start, so the upcoming maneuver to surface is
 * `currentStepIndex + 1`, clamped to the final (arrival) step. Using
 * `currentStepIndex` instead shows the maneuver you just performed — the
 * off-by-one that made "Keep left to stay on A57" appear when the exit was due.
 */
export function upcomingManeuverIndex(currentStepIndex: number, stepCount: number): number {
  if (stepCount <= 0) return 0;
  return Math.min(currentStepIndex + 1, stepCount - 1);
}

/** Legacy engine-distance metric; use maneuverStartMeters(route, index) for geometry positions. */
export function stepStartMeters(steps: readonly { distance: number }[], stepIndex: number): number {
  let along = 0;
  for (let i = 0; i < stepIndex && i < steps.length; i += 1) along += steps[i].distance;
  return along;
}
