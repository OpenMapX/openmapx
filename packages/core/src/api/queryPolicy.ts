import { ApiClientError, type ApiRequestOptions } from "./client";

export interface ApiQueryPolicy {
  gcTime: number;
  timeoutMs: number;
}

/** Default inactive-query retention for ordinary, low-cardinality metadata. */
export const DEFAULT_QUERY_GC_TIME_MS = 60 * 60_000;
/** Retention used for every policy while offline map-data retention is enabled. */
export const OFFLINE_RETENTION_GC_TIME_MS = 24 * 60 * 60_000;

let offlineRetentionEnabled = false;

/**
 * The web app persists opted-in "recent map data" queries to IndexedDB so they
 * survive going offline. TanStack only persists (and restores) queries that
 * are still within their gcTime, so the short in-memory policies below would
 * silently defeat that opt-in. Hosts flip this when the user enables offline
 * retention; policies then report the long retention instead.
 */
export function configureOfflineQueryRetention(enabled: boolean): void {
  offlineRetentionEnabled = enabled;
}

export function isOfflineQueryRetentionEnabled(): boolean {
  return offlineRetentionEnabled;
}

function policy(baseGcTime: number, timeoutMs: number): Readonly<ApiQueryPolicy> {
  return Object.freeze({
    get gcTime() {
      return offlineRetentionEnabled ? OFFLINE_RETENTION_GC_TIME_MS : baseGcTime;
    },
    timeoutMs,
  });
}

/** Fast-changing typeahead queries: obsolete almost immediately. */
export const RAPID_QUERY_POLICY: Readonly<ApiQueryPolicy> = policy(2 * 60_000, 8_000);

/** Viewport/bbox searches can contain large feature collections. */
export const MAP_QUERY_POLICY: Readonly<ApiQueryPolicy> = policy(5 * 60_000, 20_000);

/** Selected-place detail is useful briefly when navigating back. */
export const DETAIL_QUERY_POLICY: Readonly<ApiQueryPolicy> = policy(15 * 60_000, 20_000);

export function apiQueryRequestOptions(
  signal: AbortSignal,
  policy: ApiQueryPolicy,
): ApiRequestOptions {
  return { signal, timeoutMs: policy.timeoutMs };
}

/** How many times one query waits out a 429 before it reports the failure. */
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

function isRateLimited(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status === 429;
}

/**
 * Retry options for a query that many components may issue at once, such as
 * one lookup per row of a long list. A 429 is retried after the server's
 * `Retry-After` (at most 60 s, at most five times), so rows past the API's
 * per-client budget fill in as it refills instead of staying empty. Any other
 * failure retries once, as the app default does. Retries stop when the query
 * has no observers left.
 */
export const RATE_LIMIT_AWARE_RETRY = Object.freeze({
  retry: (failureCount: number, error: unknown) =>
    isRateLimited(error) ? failureCount < MAX_RATE_LIMIT_RETRIES : failureCount < 1,
  retryDelay: (attempt: number, error: unknown) =>
    isRateLimited(error)
      ? Math.min(
          MAX_RATE_LIMIT_WAIT_SECONDS,
          Math.max(1, error.retryAfterSeconds ?? 2 ** attempt),
        ) * 1000
      : Math.min(1000 * 2 ** attempt, 30_000),
});
