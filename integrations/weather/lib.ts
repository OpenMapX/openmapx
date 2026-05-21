/**
 * Shared helpers for concrete weather providers.
 *
 * Anything generic enough to appear in 2+ providers lives here — provider-
 * specific URL builders, response parsers, and symbol-code → WMO maps stay
 * in each provider because every upstream uses a different vocabulary.
 */

import { USER_AGENT } from "@openmapx/core";

/** Default HTTP timeout for upstream weather APIs. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Round to 4 decimal places. Used throughout for coordinate stability and
 * cache-key normalization — same coord ± floating noise should hit the same
 * URL.
 */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface FetchWithTimeoutOptions {
  /** Override the default timeout. */
  timeoutMs?: number;
  /** Extra headers merged with `User-Agent`. */
  headers?: Record<string, string>;
  /** Upstream name used in error messages (e.g. `"Open-Meteo"`). */
  label?: string;
}

/**
 * Fetch JSON with `User-Agent` + `AbortController`-based timeout. Throws on
 * non-2xx with the upstream's `label` baked into the message so a caller
 * always knows which provider failed without re-wrapping the error.
 */
export async function fetchJsonWithTimeout<T>(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers, label = "Weather" } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...headers },
    });
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
