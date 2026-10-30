import { type FetchJsonOptions, fetchJson } from "./fetchJson";

/** Options accepted by {@link RequestJsonScope.getJson}; failures always reject. */
export type RequestJsonOptions = Omit<FetchJsonOptions, "nullOnError">;

/**
 * Shares identical JSON acquisitions among the consumers of ONE logical unit
 * of work (for example a single place enrichment).
 *
 * The scope owns only raw, successful JSON, never a source permission or a
 * projection: every consumer must still pass its own policy check first and
 * build its own result and receipts from the clone it receives. It is
 * closure-local state with no global registry; create one per unit of work and
 * drop it with the work. Nothing is retained past the scope's last reference.
 */
export interface RequestJsonScope {
  /**
   * Strict (always-throwing) JSON acquisition with the semantics of
   * {@link fetchJson} without `nullOnError`.
   *
   * Eligible calls with an identical request identity share one underlying
   * request, including a response that settled earlier. A joiner shares the
   * original operation and its deadline, not a fresh timeout budget, and an
   * in-flight failure is shared by everyone already waiting; after a failure
   * the entry is dropped so a later call retries. Each memoized consumer gets
   * its own structured clone, so no caller can mutate another's data.
   *
   * Calls carrying a `signal`, `init`, `errorMessage`, credential-bearing
   * headers or any option outside the keyed set bypass the scope and run
   * through {@link fetchJson} unchanged. So do new requests after the entry
   * budget is exhausted.
   */
  getJson<T>(url: string, options?: RequestJsonOptions): Promise<T>;
}

/**
 * Pending-or-successful resources kept per scope. This bounds entry count, not
 * memory; each response is still bounded by fetchJson's byte ceiling.
 */
const MAX_SCOPE_ENTRIES = 8;

/** Options that take part in the request identity; any other defined option bypasses the scope. */
const KEYED_OPTIONS = new Set(["headers", "label", "maxBytes", "timeoutMs", "userAgent"]);

/**
 * Caller headers that only describe the requested representation, mirroring the
 * redirect-safe allowlist in fetchJson. Keep both in step: a header added there
 * changes what is safe to share here.
 */
const REPRESENTATION_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
]);

function option(value: unknown): string {
  return value === undefined ? "undefined" : `${typeof value}:${String(value)}`;
}

/** Request identity, or undefined when the call must not be shared. */
function requestKey(url: string, options: RequestJsonOptions): string | undefined {
  const { headers, label, maxBytes, timeoutMs, userAgent } = options;
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!KEYED_OPTIONS.has(name)) return undefined;
  }
  if (
    (timeoutMs !== undefined && typeof timeoutMs !== "number") ||
    (maxBytes !== undefined && typeof maxBytes !== "number") ||
    (label !== undefined && typeof label !== "string") ||
    (userAgent !== undefined && userAgent !== null && typeof userAgent !== "string")
  )
    return undefined;

  // Header-name spelling matters only for User-Agent: fetchJson merges plain
  // objects, so `User-Agent` replaces its default while `user-agent` sits
  // beside it and Fetch combines both. Keep that exact spelling and order.
  const representation = new Headers();
  const userAgentHeaders: Array<[string, string]> = [];
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null) return undefined;
    try {
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== "string") return undefined;
        const lower = name.toLowerCase();
        if (lower === "user-agent") userAgentHeaders.push([name, value]);
        else if (REPRESENTATION_HEADERS.has(lower)) representation.append(name, value);
        else return undefined;
      }
    } catch {
      // Invalid header: let fetchJson report it for this caller alone.
      return undefined;
    }
  }
  return JSON.stringify([
    url,
    option(timeoutMs),
    option(maxBytes),
    option(label),
    option(userAgent),
    [...representation.entries()],
    userAgentHeaders,
  ]);
}

export function createRequestJsonScope(): RequestJsonScope {
  const entries = new Map<string, Promise<unknown>>();

  function getJson<T>(url: string, options: RequestJsonOptions = {}): Promise<T> {
    const key = requestKey(url, options);
    if (key === undefined) return fetchJson<T>(url, options);

    let shared = entries.get(key);
    if (!shared) {
      if (entries.size >= MAX_SCOPE_ENTRIES) return fetchJson<T>(url, options);
      const created = fetchJson<unknown>(url, options);
      shared = created;
      entries.set(key, created);
      // Observe the failure now and forget it so only joiners share it.
      created.then(undefined, () => {
        if (entries.get(key) === created) entries.delete(key);
      });
    }
    return shared.then((value) => structuredClone(value) as T);
  }

  return { getJson };
}
