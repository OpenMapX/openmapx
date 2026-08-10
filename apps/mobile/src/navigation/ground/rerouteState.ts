/**
 * When to ask for a new route, and when to stop asking.
 *
 * Rerouting is the one thing in a navigation session that costs a network
 * request while the user is moving and possibly on a poor connection, so the
 * restraint here is deliberate:
 *
 *  - **One request at a time.** A second while the first is open would race two
 *    replacements onto the same session.
 *  - **Backoff on failure, not on success.** Failures are usually the network,
 *    and hammering it makes both the connection and the battery worse.
 *  - **A ceiling on success too.** Three reroutes in two minutes means the
 *    engine and the road disagree — a closed slip road, a GPS canyon — and a
 *    fourth would not help. Cooling off is better than churning the user's route
 *    every twenty seconds.
 */

export const REQUEST_TIMEOUT_MS = 15_000;
/** Retry delays after a network failure, in order; the last repeats. */
export const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
/** Random spread added to a retry so many devices do not retry in lockstep. */
export const RETRY_JITTER_MS = 1_000;
/** Successful reroutes within this window that trigger the churn cooldown. */
export const CHURN_WINDOW_MS = 120_000;
export const CHURN_LIMIT = 3;
export const CHURN_COOLDOWN_MS = 30_000;
/** Consecutive network failures after which retries stop until a new fix. */
export const MAX_CONSECUTIVE_FAILURES = RETRY_DELAYS_MS.length;

export type RerouteStatus = "idle" | "pending" | "in-flight" | "unavailable" | "failed";

export interface RerouteRuntime {
  status: RerouteStatus;
  requestId?: string;
  attempts: number;
  nextAttemptAtMs?: number;
  lastFailureCode?: string;
}

export interface ChurnHistory {
  /** Timestamps of recent successful replacements, oldest first. */
  successAtMs: readonly number[];
  cooldownUntilMs?: number;
}

export type RerouteDecision =
  | { allow: true }
  | { allow: false; reason: "in-flight" | "backoff" | "churn-cooldown" | "offline" | "exhausted" };

/**
 * Whether a reroute may be requested right now.
 *
 * Offline is a refusal rather than a failure: there is nothing to retry, the
 * captured route still works, and the session simply waits for connectivity.
 */
export function canRequestReroute(
  runtime: RerouteRuntime,
  churn: ChurnHistory,
  connectivity: "online" | "offline" | "unknown",
  nowMs: number,
): RerouteDecision {
  if (runtime.status === "in-flight") return { allow: false, reason: "in-flight" };
  if (connectivity === "offline") return { allow: false, reason: "offline" };
  if (churn.cooldownUntilMs !== undefined && nowMs < churn.cooldownUntilMs) {
    return { allow: false, reason: "churn-cooldown" };
  }
  if (runtime.attempts >= MAX_CONSECUTIVE_FAILURES) return { allow: false, reason: "exhausted" };
  if (runtime.nextAttemptAtMs !== undefined && nowMs < runtime.nextAttemptAtMs) {
    return { allow: false, reason: "backoff" };
  }
  return { allow: true };
}

/**
 * The delay before the next attempt after a failure.
 *
 * Jitter is injected rather than generated, so a test can pin it and a fleet of
 * devices does not retry in lockstep.
 */
export function retryDelayMs(attempts: number, jitter01: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1;
  const base = RETRY_DELAYS_MS[index];
  const clamped = Math.min(Math.max(jitter01, 0), 1);
  return base + Math.round(clamped * RETRY_JITTER_MS);
}

export function onRerouteRequested(runtime: RerouteRuntime, requestId: string): RerouteRuntime {
  return { ...runtime, status: "in-flight", requestId };
}

export function onRerouteFailed(
  runtime: RerouteRuntime,
  code: string,
  nowMs: number,
  jitter01: number,
): RerouteRuntime {
  const attempts = runtime.attempts + 1;
  return {
    status: attempts >= MAX_CONSECUTIVE_FAILURES ? "failed" : "pending",
    attempts,
    nextAttemptAtMs: nowMs + retryDelayMs(attempts, jitter01),
    lastFailureCode: code.slice(0, 64),
  };
}

/** The network was the obstacle; keep the captured route and wait. */
export function onRerouteOffline(runtime: RerouteRuntime): RerouteRuntime {
  return { status: "unavailable", attempts: runtime.attempts };
}

export function onRerouteSucceeded(): RerouteRuntime {
  // Success clears the failure history: the next problem starts from scratch
  // rather than inheriting a backoff from a network outage that is now over.
  return { status: "idle", attempts: 0 };
}

/** A stable stretch on route means the trouble is over. */
export function onBackOnRoute(runtime: RerouteRuntime): RerouteRuntime {
  return runtime.status === "idle" ? runtime : { status: "idle", attempts: 0 };
}

/**
 * Records a successful replacement and applies the churn ceiling.
 *
 * The window slides, so three reroutes spread over an hour never trip it, while
 * three in two minutes do.
 */
export function recordSuccess(churn: ChurnHistory, nowMs: number): ChurnHistory {
  const recent = [...churn.successAtMs, nowMs].filter((at) => nowMs - at <= CHURN_WINDOW_MS);
  if (recent.length >= CHURN_LIMIT) {
    return { successAtMs: recent, cooldownUntilMs: nowMs + CHURN_COOLDOWN_MS };
  }
  return { successAtMs: recent };
}

export const EMPTY_CHURN: ChurnHistory = { successAtMs: [] };
