import type { LngLat } from "../types/geometry";
import { coastState } from "./coast";
import { positionAt } from "./deadReckon";
import { pickSpeedLimit } from "./speedLimits";
import type { FixInput } from "./types";

/**
 * The rules a road session follows around the engine, shared by the browser's
 * navigation and the installed app's native session so that the same trip
 * behaves the same way in both.
 *
 * `processFix` decides where the user is and what the engine wants. This
 * module decides what the session does about it: how early cues fire for the
 * user's timing preference, when a reroute may be asked for, which speed limit
 * is shown, when and how far the position coasts through a gap in location
 * delivery, and which route of a directions answer is followed. Everything
 * here is pure; each shell supplies its state and runs the effects.
 */

export type VoiceTiming = "early" | "normal" | "late";

/**
 * How far ahead of a maneuver cues fire, per the user's timing preference: a
 * multiplier on every trigger distance. Pinned rather than taken from input, so
 * a preference can move a cue earlier or later but never schedule it
 * kilometres early or suppress it.
 */
export const VOICE_TIMING_MULTIPLIER: Readonly<Record<VoiceTiming, number>> = {
  early: 1.5,
  normal: 1,
  late: 0.6,
};

export interface SpeedLimitRoute {
  /** Per-segment limits the routing engine attached to the route, indexed by segment. */
  segmentSpeedLimits?: ReadonlyArray<number | null>;
  steps: ReadonlyArray<{ speedLimit?: unknown }>;
}

/**
 * The limit shown for where the user is, or null for no badge.
 *
 * Motorised modes only (driving and motorcycle): riders are bound by limits
 * too, while walking and cycling show none. The route's own per-segment
 * limit comes first, then a limit matched along the route for this journey
 * (`liveSpeedLimits`, indexed by the same segment), then the current step's
 * limit. A zero or negative value is a "no data" marker, never a limit.
 */
export function groundSpeedLimit(input: {
  mode: string;
  route: SpeedLimitRoute;
  liveSpeedLimits?: ReadonlyArray<number | null> | null;
  segmentIndex: number;
  stepIndex: number;
}): number | null {
  if (input.mode !== "driving" && input.mode !== "motorcycle") return null;
  const stepLimit = input.route.steps[input.stepIndex]?.speedLimit;
  return pickSpeedLimit(
    input.route.segmentSpeedLimits?.[input.segmentIndex],
    input.liveSpeedLimits?.[input.segmentIndex],
    typeof stepLimit === "number" ? stepLimit : null,
  );
}

/** How long after the last real fix the position starts to coast. */
export const COAST_START_DELAY_MS = 3_000;
/** How long a coast lasts; the assumed speed falls to zero over this span. */
export const MAX_COAST_MS = 120_000;
/** The furthest a coast may travel, whatever the speed suggests. */
export const MAX_COAST_METERS = 3_000;
/** How often a visible shell redraws a coasting position. */
export const COAST_TICK_MS = 250;

/** The last real fix's place on the route, which every estimate starts from. */
export interface CoastAnchor {
  alongMeters: number;
  speedMps: number;
  atMs: number;
}

/**
 * Whether extrapolating along the route is defensible. Off route there is no
 * line to follow, while rerouting the route is about to change, and without
 * motion there is nothing to continue.
 */
export function mayCoast(input: {
  offRoute: boolean;
  rerouting: boolean;
  speedMps: number;
}): boolean {
  return !input.offRoute && !input.rerouting && input.speedMps > 0;
}

/**
 * The estimated fix for `atMs`, or null before the coast starts and once it is
 * over. The accuracy of 1 metre marks "exactly on the route"; the fix is
 * flagged `coasted`, so nothing treats it as a measurement.
 */
export function coastedFix(
  anchor: CoastAnchor,
  geometry: LngLat[],
  cumulative: number[],
  atMs: number,
): FixInput | null {
  const elapsedMs = atMs - anchor.atMs;
  if (elapsedMs < COAST_START_DELAY_MS || elapsedMs > MAX_COAST_MS) return null;
  const coast = coastState(anchor.alongMeters, anchor.speedMps, elapsedMs, {
    startAfterMs: COAST_START_DELAY_MS,
    maxCoastMs: MAX_COAST_MS,
    maxCoastMeters: MAX_COAST_METERS,
    routeLengthMeters: cumulative[cumulative.length - 1] ?? 0,
  });
  // The assumed speed reaches zero at the end of the coast, and an estimate
  // that no longer moves has nothing further to say.
  if (!coast.coasting || coast.speedMps <= 0) return null;
  const position = positionAt(geometry, cumulative, coast.alongMeters);
  return {
    coords: position.point,
    accuracy: 1,
    speed: coast.speedMps,
    heading: position.bearing,
    timestampMs: atMs,
    coasted: true,
  };
}

/*
 * Rerouting is the one thing a session does that costs a network request while
 * the user is moving, possibly on a poor connection, so it is held back:
 *
 *  - One request at a time. A request whose answer never came back (its
 *    process died, or the code that sent it was torn down) stops counting as
 *    open once its deadline has long passed.
 *  - Nothing while offline: the captured route still guides, and the session
 *    waits for a connection.
 *  - A pause after three successful reroutes in two minutes. That many means
 *    the engine and the road disagree (a closed slip road, a GPS canyon), and
 *    a fourth new route would not help.
 *  - A growing delay after failures. The longest delay repeats, so a driver
 *    still off route keeps being offered a new route, just less often.
 *
 * Every wait is also bounded by its own length, so a clock set backwards
 * cannot stretch a pause that was meant to last seconds.
 */

/** How long a reroute request may take. */
export const REROUTE_REQUEST_TIMEOUT_MS = 15_000;
/** How long an unanswered request blocks the next: its deadline, with room for the answer. */
export const REROUTE_IN_FLIGHT_STALE_MS = REROUTE_REQUEST_TIMEOUT_MS + 5_000;
/** Delays after consecutive failures, in order; the last repeats. */
export const REROUTE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
/** Random spread added to a retry, so many devices do not retry in lockstep. */
export const REROUTE_RETRY_JITTER_MS = 1_000;
/** Consecutive failures after which rerouting is reported as failed. */
export const REROUTE_FAILURES_REPORTED = REROUTE_RETRY_DELAYS_MS.length;
/** Successful reroutes within this window that start the churn pause. */
export const REROUTE_CHURN_WINDOW_MS = 120_000;
export const REROUTE_CHURN_LIMIT = 3;
export const REROUTE_CHURN_COOLDOWN_MS = 30_000;

const MAX_RETRY_DELAY_MS =
  REROUTE_RETRY_DELAYS_MS[REROUTE_RETRY_DELAYS_MS.length - 1] + REROUTE_RETRY_JITTER_MS;

export type RerouteStatus = "idle" | "pending" | "in-flight" | "unavailable" | "failed";

export interface RerouteRuntime {
  status: RerouteStatus;
  requestId?: string;
  /** When the open request was sent. */
  requestedAtMs?: number;
  attempts: number;
  nextAttemptAtMs?: number;
  lastFailureCode?: string;
}

export interface RerouteChurn {
  /** Successful reroutes inside the churn window, oldest first. */
  successAtMs: number[];
  cooldownUntilMs?: number;
}

export const IDLE_REROUTE: Readonly<RerouteRuntime> = Object.freeze({
  status: "idle",
  attempts: 0,
});
export const EMPTY_REROUTE_CHURN: Readonly<RerouteChurn> = Object.freeze({ successAtMs: [] });

export type RerouteDecision =
  | { allow: true }
  | { allow: false; reason: "in-flight" | "offline" | "churn-cooldown" | "backoff" };

function waiting(nowMs: number, untilMs: number, longestMs: number): boolean {
  return nowMs < untilMs && untilMs - nowMs <= longestMs;
}

/** Whether a reroute the engine asked for may be requested now. */
export function canRequestReroute(
  runtime: RerouteRuntime,
  churn: RerouteChurn,
  connectivity: "online" | "offline" | "unknown",
  nowMs: number,
): RerouteDecision {
  if (
    runtime.status === "in-flight" &&
    runtime.requestedAtMs !== undefined &&
    waiting(nowMs, runtime.requestedAtMs + REROUTE_IN_FLIGHT_STALE_MS, REROUTE_IN_FLIGHT_STALE_MS)
  ) {
    return { allow: false, reason: "in-flight" };
  }
  if (connectivity === "offline") return { allow: false, reason: "offline" };
  if (
    churn.cooldownUntilMs !== undefined &&
    waiting(nowMs, churn.cooldownUntilMs, REROUTE_CHURN_COOLDOWN_MS)
  ) {
    return { allow: false, reason: "churn-cooldown" };
  }
  if (
    runtime.nextAttemptAtMs !== undefined &&
    waiting(nowMs, runtime.nextAttemptAtMs, MAX_RETRY_DELAY_MS)
  ) {
    return { allow: false, reason: "backoff" };
  }
  return { allow: true };
}

/** The delay after the given number of consecutive failures; jitter is injected. */
export function rerouteRetryDelayMs(attempts: number, jitter01: number): number {
  const index = Math.min(Math.max(attempts, 1), REROUTE_RETRY_DELAYS_MS.length) - 1;
  const clamped = Math.min(Math.max(jitter01, 0), 1);
  return REROUTE_RETRY_DELAYS_MS[index] + Math.round(clamped * REROUTE_RETRY_JITTER_MS);
}

export function onRerouteRequested(
  runtime: RerouteRuntime,
  requestId: string,
  nowMs: number,
): RerouteRuntime {
  return { status: "in-flight", requestId, requestedAtMs: nowMs, attempts: runtime.attempts };
}

export function onRerouteFailed(
  runtime: RerouteRuntime,
  code: string,
  nowMs: number,
  jitter01: number,
): RerouteRuntime {
  // Counted up to the point where rerouting is reported as failed; the delay
  // stays at its longest from there on.
  const attempts = Math.min(runtime.attempts + 1, REROUTE_FAILURES_REPORTED);
  return {
    status: attempts >= REROUTE_FAILURES_REPORTED ? "failed" : "pending",
    attempts,
    nextAttemptAtMs: nowMs + rerouteRetryDelayMs(attempts, jitter01),
    lastFailureCode: code.slice(0, 64),
  };
}

/**
 * The user asked for a reroute again. Their request skips the failure delay,
 * but not an open request or the churn pause.
 */
export function onRerouteRetryRequested(runtime: RerouteRuntime): RerouteRuntime {
  if (runtime.nextAttemptAtMs === undefined) return runtime;
  const { nextAttemptAtMs: _skipped, ...rest } = runtime;
  return rest;
}

/** The network was the obstacle: keep the captured route and wait for it. */
export function onRerouteOffline(runtime: RerouteRuntime): RerouteRuntime {
  return { status: "unavailable", attempts: runtime.attempts };
}

/** Success clears the failure history; the next problem starts from scratch. */
export function onRerouteSucceeded(): RerouteRuntime {
  return { status: "idle", attempts: 0 };
}

/**
 * Back on route, the trouble is over. A request still open is left alone: its
 * answer is applied or dropped when it arrives.
 */
export function onBackOnRoute(runtime: RerouteRuntime): RerouteRuntime {
  return runtime.status === "idle" || runtime.status === "in-flight"
    ? runtime
    : { status: "idle", attempts: 0 };
}

/**
 * Records a successful reroute. The third inside the sliding window starts the
 * pause and clears the history, so after the pause it takes three more quick
 * reroutes to pause again.
 */
export function recordRerouteSuccess(churn: RerouteChurn, nowMs: number): RerouteChurn {
  const recent = [...churn.successAtMs, nowMs].filter(
    (atMs) => atMs <= nowMs && nowMs - atMs < REROUTE_CHURN_WINDOW_MS,
  );
  if (recent.length >= REROUTE_CHURN_LIMIT) {
    return { successAtMs: [], cooldownUntilMs: nowMs + REROUTE_CHURN_COOLDOWN_MS };
  }
  return { successAtMs: recent };
}

/**
 * The route of a directions answer that a reroute follows: the one the server
 * marked active, else the first. An answer whose marked route does not exist
 * offers nothing to follow.
 */
export function rerouteCandidate<T>(answer: {
  routes?: readonly T[];
  activeRouteIndex?: number;
}): T | undefined {
  return answer.routes?.[answer.activeRouteIndex ?? 0];
}
