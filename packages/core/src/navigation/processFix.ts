import type { Route } from "@integrations/routing/types";
import { eta } from "./eta";
import { computeProgress } from "./progress";
import { shouldReroute } from "./reroute";
import { snapToRoute } from "./snap";
import type { FixInput, NavTickOptions, NavTickResult, NavTickState } from "./types";
import { nextVoiceCue } from "./voiceCue";

const HISTORY_LIMIT = 6;

/**
 * Process one GPS fix against the active route. Pure: returns the new progress,
 * off-route / reroute / arrival flags, an optional voice cue, and the next tick
 * state (deviation history + spoken-cue keys). Rejected fixes return progress=null.
 */
export function processFix(
  route: Route,
  fix: FixInput,
  state: NavTickState,
  opts: NavTickOptions,
): NavTickResult {
  if (fix.accuracy > opts.accuracyCapMeters) {
    return {
      progress: null,
      offRoute: false,
      needsReroute: false,
      arrived: false,
      voiceCue: null,
      nextState: state,
    };
  }

  const snap = snapToRoute(route.geometry, fix.coords);
  const prog = computeProgress(route, snap.alongMeters);

  const deviationHistory = [...state.deviationHistory, snap.deviationMeters].slice(-HISTORY_LIMIT);
  const offRoute = snap.deviationMeters > opts.reroute.thresholdMeters;
  const needsReroute = shouldReroute(
    deviationHistory,
    state.lastRerouteAtMs,
    fix.timestampMs,
    opts.reroute,
  );

  const arrived =
    prog.currentStepIndex === route.steps.length - 1 &&
    prog.distanceRemaining <= opts.arrivalThresholdMeters;

  const step = route.steps[prog.currentStepIndex];
  const cue = arrived
    ? null
    : nextVoiceCue(
        step,
        prog.currentStepIndex,
        prog.distanceToNextManeuver,
        opts.voiceThresholds,
        state.spokenCues,
      );

  const spokenCues = cue ? [...state.spokenCues, cue.key] : state.spokenCues;

  return {
    progress: {
      ...prog,
      snapped: snap.snapped,
      alongMeters: snap.alongMeters,
      deviationMeters: snap.deviationMeters,
      etaEpochMs: eta(prog.durationRemaining, fix.timestampMs),
    },
    offRoute,
    needsReroute,
    arrived,
    voiceCue: cue,
    nextState: {
      deviationHistory,
      lastRerouteAtMs: needsReroute ? fix.timestampMs : state.lastRerouteAtMs,
      spokenCues,
    },
  };
}
