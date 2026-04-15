import { USER_AGENT } from "../userAgent";
import type { OverpassResponse } from "./types";

const OVERPASS_URL = process.env.OVERPASS_URL
  ? `${process.env.OVERPASS_URL.replace(/\/$/, "")}/api/interpreter`
  : "https://overpass-api.de/api/interpreter";

const OVERPASS_FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";

export class OverpassRateLimitError extends Error {
  constructor() {
    super("Overpass API rate limit exceeded");
    this.name = "OverpassRateLimitError";
  }
}

export class OverpassTimeoutError extends Error {
  constructor() {
    super("Overpass API query timed out");
    this.name = "OverpassTimeoutError";
  }
}

async function fetchOverpass(url: string, query: string): Promise<OverpassResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(35_000),
  });

  if (res.status === 429) throw new OverpassRateLimitError();
  if (res.status === 504 || res.status === 408) throw new OverpassTimeoutError();
  if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);

  return res.json() as Promise<OverpassResponse>;
}

/**
 * Execute an Overpass QL query and return the parsed response.
 *
 * Tries the configured primary endpoint first. On rate-limit or server error,
 * retries once against the public fallback (overpass.kumi.systems).
 * When a custom OVERPASS_URL is set (e.g. local instance), the fallback is skipped.
 */
export async function overpassQuery(query: string): Promise<OverpassResponse> {
  try {
    return await fetchOverpass(OVERPASS_URL, query);
  } catch (err) {
    // Only fall back to the public mirror when using the default public endpoint.
    // A custom OVERPASS_URL means a local/private instance — no point falling back
    // to a different public server.
    const usingCustomUrl = !!process.env.OVERPASS_URL;
    const isFallbackable =
      err instanceof OverpassRateLimitError || err instanceof OverpassTimeoutError;
    if (!usingCustomUrl && isFallbackable) {
      return fetchOverpass(OVERPASS_FALLBACK_URL, query);
    }
    throw err;
  }
}

/**
 * Like `overpassQuery` but returns `fallback` on any error instead of throwing.
 * Useful for optional/fallback data sources where failure is acceptable.
 */
export async function overpassQuerySafe<T>(
  query: string,
  fallback: T,
): Promise<OverpassResponse | T> {
  try {
    return await overpassQuery(query);
  } catch {
    return fallback;
  }
}
