import type { Route } from "@integrations/routing/types";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "../utils/coordinates";
import { eta } from "./eta";
import { computeProgress, upcomingManeuverIndex } from "./progress";
import { shouldReroute, updateOffRouteScore } from "./reroute";
import { snapToRoute } from "./snap";
import { advanceStepGate } from "./stepGate";
import type { FixInput, NavTickOptions, NavTickResult, NavTickState } from "./types";
import { nextVoiceCue } from "./voiceCue";

const toRad = (d: number): number => (d * Math.PI) / 180;

/** Initial great-circle bearing a→b, degrees clockwise from north. */
function bearingBetween(a: LngLat, b: LngLat): number {
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Initial bearing (deg clockwise from north) of the route segment at `segmentIndex`. */
function bearingAt(geometry: LngLat[], segmentIndex: number): number {
  if (geometry.length < 2) return 0;
  const i = Math.max(0, Math.min(segmentIndex, geometry.length - 2));
  return bearingBetween(geometry[i], geometry[i + 1]);
}

/** Smallest absolute angle (deg, 0–180) between two bearings. */
function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Heading-vs-route angle past which the traveller is going the wrong way. */
const WRONG_DIRECTION_DEG = 90;
/** Heading-vs-route angle that counts as a U-turn. */
const U_TURN_DEG = 135;
/** A U-turn must persist this long (ms) before it forces a reroute on its own. */
const U_TURN_SUSTAIN_MS = 10_000;
/** Minimum raw movement (m) between fixes to trust a derived motion bearing. */
const MIN_MOTION_METERS = 3;

/**
 * The direction the traveller is actually moving (deg clockwise from north), or
 * null when it can't be told. Prefers the GPS-reported heading; otherwise
 * derives it from the raw movement between fixes, but only once they're far
 * enough apart to be meaningful.
 */
function motionBearing(fix: FixInput, lastRaw: LngLat | undefined, moving: boolean): number | null {
  if (!moving) return null;
  if (fix.heading != null && fix.heading >= 0) return fix.heading;
  if (lastRaw && haversineDistance(lastRaw, fix.coords) >= MIN_MOTION_METERS) {
    return bearingBetween(lastRaw, fix.coords);
  }
  return null;
}

/**
 * Process one GPS fix against the active route. Pure: returns the new progress,
 * off-route / reroute / arrival flags, an optional voice cue, and the next tick
 * state. Fixes worse than the sanity accuracy cap are rejected (progress=null);
 * merely-noisy fixes are kept but flag `weakGps` and widen the off-route
 * envelope. Off-route evidence accrues into a speed-weighted score (escalating
 * when heading the wrong way / U-turning) that, once high enough and past a
 * growing back-off, asks for a reroute.
 */
export function processFix(
  route: Route,
  fix: FixInput,
  state: NavTickState,
  opts: NavTickOptions,
): NavTickResult {
  // Reject fixes that are too inaccurate or have a non-finite coordinate: a
  // NaN/Infinity longitude or latitude would throw in the snap and otherwise
  // poison every downstream distance with NaN.
  if (
    fix.accuracy > opts.accuracyCapMeters ||
    !Number.isFinite(fix.coords[0]) ||
    !Number.isFinite(fix.coords[1])
  ) {
    return {
      progress: null,
      accuracyRejected: true,
      weakGps: true,
      offRoute: false,
      needsReroute: false,
      arrived: false,
      voiceCue: null,
      nextState: state,
    };
  }

  const weakGps = fix.accuracy > opts.weakGpsMeters;
  const snap = snapToRoute(route.geometry, fix.coords);
  // Gate which step is shown/announced on maneuver completion, so the banner
  // doesn't flip before the turn is made and a brief forward GPS jump can't skip
  // a step. The gate is monotonic; arrival (below) stays distance-based so it's
  // never blocked by the gate.
  const gate = advanceStepGate(
    route,
    snap.alongMeters,
    {
      committedStepIndex: state.committedStepIndex ?? 0,
      reachedStepEnd: state.reachedStepEnd ?? false,
    },
    opts.stepGateEntryMeters,
    opts.stepGateExitMeters,
  );
  const prog = computeProgress(route, snap.alongMeters, gate.committedStepIndex);

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

  // Off-route test, with the threshold widened by the fix's reported accuracy so
  // a noisy fix in an urban canyon doesn't read as a deviation.
  const offRoute = snap.deviationMeters > opts.reroute.thresholdMeters + fix.accuracy;
  const moving = speedMps > opts.minMovingSpeedMps;

  // Compare the travel heading to the route's heading here to spot wrong-way
  // travel and U-turns, which escalate / force a reroute ahead of the score.
  const routeBearing = bearingAt(route.geometry, snap.segmentIndex);
  const heading = motionBearing(fix, state.lastRaw, moving);
  const bearingOff = heading === null ? null : angularDiff(heading, routeBearing);
  const wrongDirection = offRoute && bearingOff !== null && bearingOff > WRONG_DIRECTION_DEG;
  const uTurnNow = bearingOff !== null && bearingOff > U_TURN_DEG;
  const uTurnSinceMs = uTurnNow ? (state.uTurnSinceMs ?? fix.timestampMs) : null;
  const sustainedUTurn =
    uTurnSinceMs !== null && fix.timestampMs - uTurnSinceMs >= U_TURN_SUSTAIN_MS;

  const score = updateOffRouteScore(
    state.offRouteScore,
    offRoute,
    moving,
    wrongDirection,
    snap.deviationMeters,
    state.lastDeviation,
  );
  // A sustained U-turn forces the decision even before the score builds up.
  const decisionScore = sustainedUTurn ? Math.max(score, opts.reroute.scoreThreshold) : score;
  // Heading the wrong way collapses the back-off so the reroute can fire now.
  const currentBackoff =
    state.rerouteBackoffMs > 0 ? state.rerouteBackoffMs : opts.reroute.backoffBaseMs;
  const decisionBackoff = wrongDirection ? opts.reroute.backoffBaseMs : currentBackoff;
  const needsReroute = shouldReroute(
    decisionScore,
    state.lastRerouteAtMs,
    decisionBackoff,
    fix.timestampMs,
    opts.reroute,
  );

  // Arrival: within the threshold of the destination AND the gate has committed
  // to the final travel step. We key on the gate index (not the final step's
  // distance) because real engines append a 0-distance "arrive" maneuver — using
  // `distanceRemaining <= lastStep.distance` would collapse to `<= 0` and only
  // fire when snapped exactly at the route end. `committedStepIndex >= lastIndex
  // - 1` reaches true on the last travel step, so a multi-step route can't
  // false-arrive near the start.
  const lastIndex = route.steps.length - 1;
  const arrived =
    prog.distanceRemaining <= opts.arrivalThresholdMeters &&
    gate.committedStepIndex >= lastIndex - 1;

  // Announce the UPCOMING maneuver (at the end of the current step), not the one
  // already performed at the start of it. distanceToNextManeuver counts down to
  // exactly this maneuver.
  const upcomingIndex = upcomingManeuverIndex(prog.currentStepIndex, route.steps.length);
  const step = route.steps[upcomingIndex];
  // Suppress voice while off the route: the snapped distance-to-maneuver is a
  // phantom (a laterally-far fix still projects onto the line somewhere), so any
  // countdown read off it would be wrong. The off-route/reroute UI is the right
  // cue instead; normal cues resume on return.
  const cue =
    arrived || offRoute
      ? null
      : nextVoiceCue(
          step,
          upcomingIndex,
          prog.distanceToNextManeuver,
          speedMps,
          opts.voice,
          opts.announceMultiplier,
          state.spokenCues,
        );

  const spokenCues = cue ? [...state.spokenCues, cue.key] : state.spokenCues;

  // Grow the back-off on each reroute, reset it once back on route (or to allow
  // a prompt wrong-direction reroute), otherwise hold it.
  let nextBackoff: number;
  if (needsReroute) {
    nextBackoff = Math.min(currentBackoff * 1.5, opts.reroute.backoffMaxMs);
  } else if (!offRoute || wrongDirection) {
    nextBackoff = opts.reroute.backoffBaseMs;
  } else {
    nextBackoff = currentBackoff;
  }

  return {
    progress: {
      ...prog,
      snapped: snap.snapped,
      alongMeters: snap.alongMeters,
      deviationMeters: snap.deviationMeters,
      segmentIndex: snap.segmentIndex,
      etaEpochMs: eta(prog.durationRemaining, fix.timestampMs),
      bearing: routeBearing,
      speedMps,
    },
    accuracyRejected: false,
    weakGps,
    offRoute,
    needsReroute,
    arrived,
    voiceCue: cue,
    nextState: {
      offRouteScore: needsReroute ? 0 : score,
      lastRerouteAtMs: needsReroute ? fix.timestampMs : state.lastRerouteAtMs,
      rerouteBackoffMs: nextBackoff,
      spokenCues,
      lastAlongMeters: snap.alongMeters,
      lastFixMs: fix.timestampMs,
      lastRaw: fix.coords,
      lastDeviation: snap.deviationMeters,
      uTurnSinceMs: needsReroute ? null : uTurnSinceMs,
      committedStepIndex: gate.committedStepIndex,
      reachedStepEnd: gate.reachedStepEnd,
    },
  };
}
