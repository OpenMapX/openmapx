import type { OverpassResponse } from "./types";

const OVERPASS_URL = process.env.OVERPASS_URL
  ? `${process.env.OVERPASS_URL.replace(/\/$/, "")}/api/interpreter`
  : "https://overpass-api.de/api/interpreter";
const USER_AGENT = "OpenMapX/1.0 (+https://openmapx.org)";

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

/**
 * Execute an Overpass QL query and return the parsed response.
 *
 * Handles POST encoding, User-Agent, rate-limit detection (429),
 * and consistent error messages for all Overpass consumers.
 */
export async function overpassQuery(query: string): Promise<OverpassResponse> {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(35_000),
  });

  if (res.status === 429) {
    throw new OverpassRateLimitError();
  }
  if (res.status === 504 || res.status === 408) {
    throw new OverpassTimeoutError();
  }
  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status}`);
  }

  return res.json() as Promise<OverpassResponse>;
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
