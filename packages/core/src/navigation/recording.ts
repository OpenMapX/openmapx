import type { Route, TravelMode } from "../types/routing";
import { navOptionsForMode } from "./options";
import { processFix } from "./processFix";
import type { FixInput, NavTickResult, NavTickState } from "./types";

/** Schema version of the recording format; bump on breaking shape changes. */
export const NAV_RECORDING_VERSION = 1;

/** A route swapped in mid-session, with the number of fixes recorded before it. */
export interface RecordedReroute {
  /** How many fixes were recorded under the previous route before this applied. */
  afterFixCount: number;
  route: Route;
}

/**
 * A captured navigation session: the raw GPS fix stream plus the route(s) it ran
 * against. Because {@link processFix} is pure and {@link FixInput} is its only
 * input, re-feeding `fixes` reproduces the exact engine output — a deterministic
 * bug-repro and regression artifact (unlike a state-only replay, which can't
 * re-exercise the engine).
 */
export interface NavRecording {
  version: number;
  /** Epoch ms of the first fix; the timeline origin. */
  startedAtMs: number;
  mode: TravelMode;
  /** The initial route. */
  route: Route;
  /** Routes swapped in during the session (reroutes / stop adds), in order. */
  reroutes: RecordedReroute[];
  /** Raw GPS fixes in capture order. */
  fixes: FixInput[];
}

/** One replayed fix: the engine result and which route was active for it. */
export interface ReplayStep {
  fix: FixInput;
  result: NavTickResult;
  /** Index into `[route, ...reroutes]` that was active for this fix. */
  routeIndex: number;
}

/** The tick state a fresh session (or a post-reroute reset) starts from. */
export function freshNavTickState(): NavTickState {
  return { offRouteScore: 0, lastRerouteAtMs: null, rerouteBackoffMs: 0, spokenCues: [] };
}

/**
 * Re-feed a recording's fixes through the real {@link processFix} engine,
 * switching to each rerouted route at its boundary and resetting tick state
 * there (mirroring the live engine). Pure and deterministic: identical input
 * yields identical {@link ReplayStep}s, so a recorded session can pin engine
 * behaviour in a test.
 */
export function replayRecording(recording: NavRecording): ReplayStep[] {
  const opts = navOptionsForMode(recording.mode);
  const routes = [recording.route, ...recording.reroutes.map((r) => r.route)];
  // Fix index at which each reroute takes effect (cumulative).
  const boundaries = recording.reroutes.map((r) => r.afterFixCount);

  const steps: ReplayStep[] = [];
  let routeIndex = 0;
  let state = freshNavTickState();

  recording.fixes.forEach((fix, i) => {
    // Apply any reroute whose boundary we've reached, resetting state like the
    // engine does on a route swap.
    while (routeIndex < boundaries.length && i >= boundaries[routeIndex]) {
      routeIndex += 1;
      state = freshNavTickState();
    }
    const result = processFix(routes[routeIndex], fix, state, opts);
    state = result.nextState;
    steps.push({ fix, result, routeIndex });
  });

  return steps;
}

export type TimelineEventType =
  | "start"
  | "step"
  | "reroute"
  | "offRoute"
  | "onRoute"
  | "arrived"
  | "signalLost";

export interface TimelineEvent {
  type: TimelineEventType;
  /** Index into the replayed steps. */
  fixIndex: number;
  /** Milliseconds from the first fix. */
  offsetMs: number;
  label: string;
}

/** A gap longer than this between consecutive fixes reads as a lost GPS signal. */
export const SIGNAL_LOST_GAP_MS = 10_000;

/**
 * Reduce a replayed drive into a human-readable activity timeline by diffing
 * consecutive steps: navigation start, step advances, reroutes, off/on-route
 * transitions, arrival, and lost-signal gaps. Pure — drives a debug overlay or
 * a recording summary.
 */
export function extractTimeline(
  steps: ReplayStep[],
  opts: { gapThresholdMs?: number } = {},
): TimelineEvent[] {
  const gapMs = opts.gapThresholdMs ?? SIGNAL_LOST_GAP_MS;
  const t0 = steps[0]?.fix.timestampMs ?? 0;
  const out: TimelineEvent[] = [];

  let started = false;
  let arrived = false;
  let prevStepIndex: number | null = null;
  let prevRouteIndex: number | null = null;
  let prevOffRoute = false;
  let prevTs: number | null = null;

  steps.forEach((s, i) => {
    const ts = s.fix.timestampMs;
    const push = (type: TimelineEventType, label: string) =>
      out.push({ type, fixIndex: i, offsetMs: ts - t0, label });

    // Only meaningful once navigation has started — a gap among the leading
    // accuracy-rejected fixes is startup noise, not a lost signal mid-trip.
    if (started && prevTs !== null && ts - prevTs > gapMs) {
      push("signalLost", `No GPS for ${Math.round((ts - prevTs) / 1000)}s`);
    }
    prevTs = ts;

    const prog = s.result.progress;
    if (!prog) return;

    if (!started) {
      started = true;
      push("start", "Navigation started");
    }
    if (prevRouteIndex !== null && s.routeIndex !== prevRouteIndex) push("reroute", "Rerouted");
    prevRouteIndex = s.routeIndex;

    if (prevStepIndex !== null && prog.currentStepIndex > prevStepIndex) {
      push("step", `Step ${prog.currentStepIndex}`);
    }
    prevStepIndex = prog.currentStepIndex;

    if (s.result.offRoute && !prevOffRoute) push("offRoute", "Off route");
    else if (!s.result.offRoute && prevOffRoute) push("onRoute", "Back on route");
    prevOffRoute = s.result.offRoute;

    if (s.result.arrived && !arrived) {
      arrived = true;
      push("arrived", "Arrived");
    }
  });

  return out;
}
