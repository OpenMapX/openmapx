/**
 * When to ask the server for fresh live data, and — more importantly — when not
 * to.
 *
 * The refresh token rotates: every successful call returns a new one and
 * invalidates the old. That single fact drives most of what follows.
 *
 *  - **One request per generation.** Two concurrent calls would spend the same
 *    token twice, and the second would fail with the first's replacement
 *    already committed.
 *  - **An ambiguous failure is not retried.** If the request timed out, the
 *    server may or may not have consumed the token. Retrying it blindly is a
 *    coin flip that, when it loses, silently ends live data for the trip. The
 *    chain is marked broken and recovery goes through a full replan instead.
 *  - **A generation invalidates in-flight work.** A replan or a replacement
 *    bumps it, so a reply already on the wire lands on nothing.
 */

/** How often live data is worth refetching while riding. */
export const REFRESH_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** Backoff after an *unambiguous* failure, in order; the last repeats. */
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
export const MAX_CONSECUTIVE_FAILURES = RETRY_DELAYS_MS.length;

export type RefreshStatus = "ready" | "in-flight" | "stale" | "broken";

export interface RefreshRuntime {
  status: RefreshStatus;
  generation: number;
  requestId?: string;
  nextAttemptAtMs?: number;
  attempts: number;
}

export type RefreshDecision =
  | { refresh: true }
  | {
      refresh: false;
      reason: "in-flight" | "too-soon" | "offline" | "no-token" | "broken" | "terminal";
    };

export interface RefreshContext {
  runtime: RefreshRuntime;
  hasToken: boolean;
  connectivity: "online" | "offline" | "unknown";
  status: "preparing" | "active" | "arrived" | "stopped" | "expired" | "error";
  nowMs: number;
}

/**
 * Whether a refresh should be sent right now.
 *
 * `broken` is deliberately terminal for refreshing: once the chain may have been
 * consumed, no amount of waiting makes the old token valid again.
 */
export function shouldRefresh(context: RefreshContext): RefreshDecision {
  const { runtime, hasToken, connectivity, status, nowMs } = context;

  if (status !== "active" && status !== "preparing") return { refresh: false, reason: "terminal" };
  if (!hasToken) return { refresh: false, reason: "no-token" };
  if (runtime.status === "in-flight") return { refresh: false, reason: "in-flight" };
  if (runtime.status === "broken") return { refresh: false, reason: "broken" };
  if (connectivity === "offline") return { refresh: false, reason: "offline" };
  if (runtime.nextAttemptAtMs !== undefined && nowMs < runtime.nextAttemptAtMs) {
    return { refresh: false, reason: "too-soon" };
  }
  return { refresh: true };
}

export function onRefreshRequested(
  runtime: RefreshRuntime,
  requestId: string,
  nowMs: number,
): RefreshRuntime {
  return {
    status: "in-flight",
    generation: runtime.generation + 1,
    requestId,
    attempts: runtime.attempts,
    nextAttemptAtMs: nowMs + REQUEST_TIMEOUT_MS,
  };
}

export function onRefreshSucceeded(runtime: RefreshRuntime, nowMs: number): RefreshRuntime {
  return {
    status: "ready",
    generation: runtime.generation,
    attempts: 0,
    nextAttemptAtMs: nowMs + REFRESH_INTERVAL_MS,
  };
}

/** Why a refresh failed, and therefore whether the token might have been spent. */
export type RefreshFailure =
  /** The server answered; the token was consumed and a new one was not obtained. */
  | "rejected"
  /** No answer arrived. The server may or may not have consumed the token. */
  | "ambiguous"
  /** The network was simply absent; nothing was sent. */
  | "offline";

/**
 * Applies a failure.
 *
 * The distinction between `rejected` and `ambiguous` is the whole point. A
 * rejection is information — the token is gone, and the chain is broken. An
 * ambiguous timeout is the absence of information, and the safe reading of "we
 * do not know whether the token was spent" is that it was.
 */
export function onRefreshFailed(runtime: RefreshRuntime, failure: RefreshFailure): RefreshRuntime {
  if (failure === "offline") {
    // Nothing left the device, so the token is certainly still valid.
    return { status: "stale", generation: runtime.generation, attempts: runtime.attempts };
  }
  if (failure === "ambiguous" || failure === "rejected") {
    return { status: "broken", generation: runtime.generation, attempts: runtime.attempts + 1 };
  }
  return runtime;
}

/**
 * Applies a transport failure that did not reach the refresh endpoint at all.
 *
 * Kept separate from `onRefreshFailed` because it is the one failure that can
 * safely be retried with the same token: a DNS failure or a refused connection
 * means the request never arrived.
 */
export function onRefreshUnreachable(runtime: RefreshRuntime, nowMs: number): RefreshRuntime {
  const attempts = runtime.attempts + 1;
  const index = Math.min(attempts, RETRY_DELAYS_MS.length) - 1;
  return {
    status: attempts >= MAX_CONSECUTIVE_FAILURES ? "stale" : "ready",
    generation: runtime.generation,
    attempts,
    nextAttemptAtMs: nowMs + RETRY_DELAYS_MS[index],
  };
}

/** Whether a reply still belongs to the session state that asked for it. */
export function isCurrentGeneration(
  runtime: RefreshRuntime,
  reply: { generation: number; requestId: string },
): boolean {
  return runtime.generation === reply.generation && runtime.requestId === reply.requestId;
}
