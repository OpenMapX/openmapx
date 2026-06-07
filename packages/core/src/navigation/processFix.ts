import type { Route } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";
import { eta } from "./eta";
import { computeProgress, upcomingManeuverIndex } from "./progress";
import { shouldReroute } from "./reroute";
import { snapToRoute } from "./snap";
import type { FixInput, NavTickOptions, NavTickResult, NavTickState } from "./types";
import { nextVoiceCue } from "./voiceCue";

const HISTORY_LIMIT = 6;

/** Initial bearing (deg clockwise from north) of the route segment at `segmentIndex`. */
function bearingAt(geometry: LngLat[], segmentIndex: number): number {
  if (geometry.length < 2) return 0;
  const i = Math.max(0, Math.min(segmentIndex, geometry.length - 2));
  const [lng1, lat1] = geometry[i];
  const [lng2, lat2] = geometry[i + 1];
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

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
      accuracyRejected: true,
      offRoute: false,
      needsReroute: false,
      arrived: false,
      voiceCue: null,
      nextState: state,
    };
  }

  const snap = snapToRoute(route.geometry, fix.coords);
  const prog = computeProgress(route, snap.alongMeters);

  // Prefer the GPS-reported ground speed; otherwise estimate it from how far we
  // moved along the route since the previous fix. Feeds the follow camera's
  // between-fix dead reckoning.
  let speedMps = fix.speed != null && fix.speed >= 0 ? fix.speed : 0;
  if (
    (fix.speed == null || fix.speed < 0) &&
    state.lastAlongMeters != null &&
    state.lastFixMs != null
  ) {
    const dtSeconds = (fix.timestampMs - state.lastFixMs) / 1000;
    if (dtSeconds > 0) {
      speedMps = Math.max((snap.alongMeters - state.lastAlongMeters) / dtSeconds, 0);
    }
  }

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

  // Announce the UPCOMING maneuver (at the end of the current step), not the one
  // already performed at the start of it. distanceToNextManeuver counts down to
  // exactly this maneuver.
  const upcomingIndex = upcomingManeuverIndex(prog.currentStepIndex, route.steps.length);
  const step = route.steps[upcomingIndex];
  const cue = arrived
    ? null
    : nextVoiceCue(
        step,
        upcomingIndex,
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
      bearing: bearingAt(route.geometry, snap.segmentIndex),
      speedMps,
    },
    accuracyRejected: false,
    offRoute,
    needsReroute,
    arrived,
    voiceCue: cue,
    nextState: {
      deviationHistory,
      lastRerouteAtMs: needsReroute ? fix.timestampMs : state.lastRerouteAtMs,
      spokenCues,
      lastAlongMeters: snap.alongMeters,
      lastFixMs: fix.timestampMs,
    },
  };
}
