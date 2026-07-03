import type { Route } from "../types/routing";
import type { ProgressResult } from "./types";

/**
 * Map a distance traveled along the route to the current step, the distance to
 * the next maneuver, and the remaining distance/duration to the destination.
 * Step boundaries are derived from per-step `distance` (cumulative).
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
    return {
      currentStepIndex: 0,
      distanceToNextManeuver: 0,
      distanceRemaining: 0,
      durationRemaining: 0,
    };
  }
  const total = route.distance;
  const along = Math.max(0, Math.min(alongMeters, total));

  // The geometric step the snapped position is actually in — drives the
  // distance/duration remaining (ETA), which must stay independent of the gate.
  let rawIdx = steps.length - 1;
  let cumEnd = 0;
  for (let i = 0; i < steps.length; i++) {
    cumEnd += steps[i].distance;
    if (along <= cumEnd) {
      rawIdx = i;
      break;
    }
  }

  // The displayed/announced step: the gate may hold an earlier one until the
  // maneuver is completed.
  const idx =
    forcedStepIndex != null ? Math.min(Math.max(forcedStepIndex, 0), steps.length - 1) : rawIdx;

  // Distance to the next maneuver is to the end of the DISPLAY step.
  let endOfDisplay = 0;
  for (let i = 0; i <= idx; i++) endOfDisplay += steps[i].distance;
  const distanceToNextManeuver = Math.max(0, endOfDisplay - along);

  const distanceRemaining = Math.max(0, total - along);

  // Duration remaining is geometric: pro-rate the RAW current step by how much of
  // it is left, then add every later step — so a lagging display gate can't add
  // the already-driven part of the current step back into the ETA.
  let endOfRaw = 0;
  for (let i = 0; i <= rawIdx; i++) endOfRaw += steps[i].distance;
  const rawCurrent = steps[rawIdx];
  const rawDistanceToEnd = Math.max(0, endOfRaw - along);
  const fractionLeft = rawCurrent.distance > 0 ? rawDistanceToEnd / rawCurrent.distance : 0;
  let durationRemaining = rawCurrent.duration * fractionLeft;
  for (let i = rawIdx + 1; i < steps.length; i++) durationRemaining += steps[i].duration;

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
