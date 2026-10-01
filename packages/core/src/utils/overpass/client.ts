import { USER_AGENT } from "../userAgent";
import type { OverpassResponse } from "./types";

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";
let configuredOverpassUrl: string | null = null;

function normalizeOverpassUrl(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.endsWith("/api/interpreter") ? trimmed : `${trimmed}/api/interpreter`;
}

function currentOverpassUrl(): string {
  if (configuredOverpassUrl) return configuredOverpassUrl;
  const envUrl = process.env.OVERPASS_URL?.trim();
  return envUrl ? normalizeOverpassUrl(envUrl) : DEFAULT_OVERPASS_URL;
}

export function setOverpassUrl(url: string | undefined): void {
  const trimmed = url?.trim();
  configuredOverpassUrl = trimmed && trimmed.length > 0 ? normalizeOverpassUrl(trimmed) : null;
}

export class OverpassRateLimitError extends Error {
  constructor() {
    super("Overpass API rate limit exceeded");
    this.name = "OverpassRateLimitError";
  }
}

/**
 * The query ran out of the time or memory it asked for: the area holds too
 * much for it, and a smaller one may work. Overpass says so in the answer's
 * `remark`, not with a status.
 */
export class OverpassTimeoutError extends Error {
  constructor() {
    super("Overpass API query timed out");
    this.name = "OverpassTimeoutError";
  }
}

/**
 * The server would not run the query now, or did not answer: Overpass sends
 * 504 when it is too busy to take a query of any size. A smaller area does
 * not help; trying again later may.
 */
export class OverpassUnavailableError extends Error {
  constructor() {
    super("Overpass API unavailable");
    this.name = "OverpassUnavailableError";
  }
}

/**
 * How long to wait for an answer. Queries ask the server for 15–25 s; a busy
 * server can queue a query past that without answering at all.
 */
const OVERPASS_REQUEST_TIMEOUT_MS = 35_000;

async function fetchOverpass(url: string, query: string): Promise<OverpassResponse> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429) throw new OverpassRateLimitError();
    if (res.status === 504 || res.status === 408) throw new OverpassUnavailableError();
    if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);

    return (await res.json()) as OverpassResponse;
  } catch (err) {
    // A server that does not answer in time is as unavailable as one that
    // says it is too busy.
    if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
      throw new OverpassUnavailableError();
    }
    throw err;
  }
}

/**
 * Whether an answer's remark says the query ran out of time or memory, in
 * which case its elements are only what was found before it stopped.
 */
export function isOverpassRuntimeLimit(remark: string | undefined): boolean {
  return /runtime error/i.test(remark ?? "") && /timed out|out of memory/i.test(remark ?? "");
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
    return await fetchOverpass(currentOverpassUrl(), query);
  } catch (err) {
    // Only fall back to the public mirror when using the default public endpoint.
    // A custom OVERPASS_URL means a local/private instance — no point falling back
    // to a different public server.
    const usingCustomUrl = configuredOverpassUrl !== null || !!process.env.OVERPASS_URL;
    const isFallbackable =
      err instanceof OverpassRateLimitError || err instanceof OverpassUnavailableError;
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
