import type { Route } from "@integrations/routing/types";
import type { ProgressResult } from "./types";

/**
 * Map a distance traveled along the route to the current step, the distance to
 * the next maneuver, and the remaining distance/duration to the destination.
 * Step boundaries are derived from per-step `distance` (cumulative).
 */
export function computeProgress(route: Route, alongMeters: number): ProgressResult {
  const steps = route.steps;
  if (steps.length === 0) {
    return {
      currentStepIndex: 0,
      distanceToNextManeuver: 0,
      distanceRemaining: 0,
      durationRemaining: 0,
    };
  }
  const total = route.distance;
  const along = Math.max(0, Math.min(alongMeters, total));

  let cumEnd = 0;
  let idx = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    cumEnd += steps[i].distance;
    if (along <= cumEnd) {
      idx = i;
      break;
    }
  }

  let endOfStep = 0;
  for (let i = 0; i <= idx; i++) endOfStep += steps[i].distance;

  const distanceToNextManeuver = Math.max(0, endOfStep - along);
  const distanceRemaining = Math.max(0, total - along);

  const current = steps[idx];
  const fractionLeft = current.distance > 0 ? distanceToNextManeuver / current.distance : 0;
  let durationRemaining = current.duration * fractionLeft;
  for (let i = idx + 1; i < steps.length; i++) durationRemaining += steps[i].duration;

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
