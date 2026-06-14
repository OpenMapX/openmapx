import type { Route } from "@integrations/routing/types";

export interface StepGateState {
  /** The step committed for display/announcement. Monotonic — never decreases. */
  committedStepIndex: number;
  /** Whether the user has come within `entryMeters` of the committed step's end. */
  reachedStepEnd: boolean;
}

/**
 * Decide which step to show/announce, gating advance on maneuver completion.
 *
 * A bare "the step containing the snapped position" flips the banner the instant
 * the snapped arc-length crosses a step boundary — which a momentary GPS jump
 * near a maneuver, or a self-intersecting route, can do before the turn is
 * actually made. This gate instead requires the user to first come within
 * `entryMeters` of the step's end (entry) and then travel `exitMeters` past it
 * (exit) before advancing, so the maneuver reads as completed first. It is
 * monotonic (the committed step never moves backward — we assume forward travel)
 * and catches up across several steps in one tick on a large genuine jump. The
 * final step is never advanced past; arrival is decided by distance-to-
 * destination, not this gate.
 */
export function advanceStepGate(
  route: Route,
  alongMeters: number,
  prev: StepGateState,
  entryMeters: number,
  exitMeters: number,
): StepGateState {
  const steps = route.steps;
  const lastIndex = steps.length - 1;
  if (lastIndex <= 0) return { committedStepIndex: 0, reachedStepEnd: false };

  // Cumulative end arc-length of each step.
  const ends: number[] = [];
  let acc = 0;
  for (const s of steps) {
    acc += s.distance;
    ends.push(acc);
  }

  let committed = Math.min(Math.max(prev.committedStepIndex, 0), lastIndex);
  let entered = prev.reachedStepEnd;

  // A zero-distance step (e.g. the final "arrive" maneuver, or a tight mid-route
  // cue) has the same cumulative end as its predecessor, so this loop passes
  // straight through it in one tick — it is never the "current" step, only ever
  // shown/announced as the upcoming maneuver. That is intended: there is no
  // travel to spend on it. The loop still stops at the next non-zero step.
  while (committed < lastIndex) {
    const end = ends[committed];
    if (!entered && alongMeters >= end - entryMeters) entered = true;
    if (entered && alongMeters >= end + exitMeters) {
      committed += 1;
      entered = false;
    } else {
      break;
    }
  }

  return { committedStepIndex: committed, reachedStepEnd: entered };
}
