/** Native refresh retries ambiguous replies only within the server replay window. */

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
  firstAttemptAtMs?: number;
  ambiguousAttempts?: number;
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
 * A rejected handle or exhausted replay window is terminal for refreshing.
 */
export function shouldRefresh(context: RefreshContext): RefreshDecision {
  const { runtime, hasToken, connectivity, status, nowMs } = context;

  if (status !== "active" && status !== "preparing") return { refresh: false, reason: "terminal" };
  if (!hasToken) return { refresh: false, reason: "no-token" };
  if (runtime.status === "in-flight") return { refresh: false, reason: "in-flight" };
  if (
    runtime.firstAttemptAtMs !== undefined &&
    (runtime.ambiguousAttempts ?? 0) > 0 &&
    nowMs - runtime.firstAttemptAtMs >= 120_000
  )
    return { refresh: false, reason: "broken" };
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
    firstAttemptAtMs: (runtime.ambiguousAttempts ?? 0) > 0 ? runtime.firstAttemptAtMs : nowMs,
    ambiguousAttempts: runtime.ambiguousAttempts,
    nextAttemptAtMs: nowMs + REQUEST_TIMEOUT_MS + 5_000,
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
  | "offline"
  | "retryable";

/** Rejections are terminal; ambiguous replies retry the same token at most three times. */
export function onRefreshFailed(
  runtime: RefreshRuntime,
  failure: RefreshFailure,
  nowMs = Date.now(),
  hasToken = true,
): RefreshRuntime {
  if (!hasToken)
    return onRefreshUnreachable(
      { ...runtime, ambiguousAttempts: undefined, firstAttemptAtMs: undefined },
      nowMs,
    );
  if (failure === "offline") return { ...runtime, status: "stale" };
  if (failure === "retryable") return onRefreshUnreachable(runtime, nowMs);
  const attempts = Math.min(64, runtime.attempts + 1);
  const firstAttemptAtMs = runtime.firstAttemptAtMs ?? nowMs;
  const ambiguousAttempts = Math.min(3, (runtime.ambiguousAttempts ?? 0) + 1);
  return {
    status:
      failure === "rejected" || ambiguousAttempts >= 3 || nowMs - firstAttemptAtMs >= 120_000
        ? "broken"
        : "ready",
    generation: runtime.generation,
    attempts,
    firstAttemptAtMs,
    ambiguousAttempts,
    nextAttemptAtMs: nowMs + 30_000,
  };
}

/**
 * Applies a transport failure that did not reach the refresh endpoint at all.
 *
 * Kept separate from `onRefreshFailed` because it is the one failure that can
 * safely be retried with the same token: a DNS failure or a refused connection
 * means the request never arrived.
 */
export function onRefreshUnreachable(runtime: RefreshRuntime, nowMs: number): RefreshRuntime {
  const attempts = Math.min(64, runtime.attempts + 1);
  const index = Math.min(attempts, RETRY_DELAYS_MS.length) - 1;
  return {
    status: attempts >= MAX_CONSECUTIVE_FAILURES ? "stale" : "ready",
    generation: runtime.generation,
    attempts,
    ...((runtime.ambiguousAttempts ?? 0) > 0
      ? { firstAttemptAtMs: runtime.firstAttemptAtMs, ambiguousAttempts: runtime.ambiguousAttempts }
      : {}),
    nextAttemptAtMs:
      nowMs + ((runtime.ambiguousAttempts ?? 0) > 0 ? REFRESH_INTERVAL_MS : RETRY_DELAYS_MS[index]),
  };
}

/** Whether a reply still belongs to the session state that asked for it. */
export function isCurrentGeneration(
  runtime: RefreshRuntime,
  reply: { generation: number; requestId: string },
): boolean {
  return runtime.generation === reply.generation && runtime.requestId === reply.requestId;
}
