import { type Attribution, OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { USER_AGENT } from "../userAgent";
import type { OverpassResponse } from "./types";

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";
let configuredOverpassUrl: string | null = null;

let captureSupplier: (url: string) => readonly Attribution[] = () => [OPENSTREETMAP_ATTRIBUTION];

/** Trusted built-in adapter: resolve the actual endpoint, including a fallback response. */
export function setOverpassContributorResolver(
  resolve?: (url: string) => readonly Attribution[],
): void {
  captureSupplier = resolve ?? (() => [OPENSTREETMAP_ATTRIBUTION]);
}

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
 * 504 when it is too busy to take a query of any size, and its dispatcher
 * refuses some queries with an error page instead (`duplicate_query`, while
 * the same query string runs or ran moments ago). A smaller area does not
 * help; trying again later may. `detail` is Overpass's own error text.
 */
export class OverpassUnavailableError extends Error {
  constructor(readonly detail?: string) {
    super(detail ? `Overpass API unavailable: ${detail}` : "Overpass API unavailable");
    this.name = "OverpassUnavailableError";
  }
}

/**
 * The error text of the HTML page Overpass sends instead of the requested
 * JSON when it can't run a query, with HTTP 200: each
 * `<strong …>Error</strong>: …` paragraph, tags dropped and entities decoded.
 * Null when the body is no such page.
 */
function overpassErrorPageText(body: string): string | null {
  if (!/<html[\s>]/i.test(body)) return null;
  const errors = [...body.matchAll(/<strong[^>]*>\s*Error\s*<\/strong>\s*:?([\s\S]*?)<\/p>/gi)]
    .map((match) =>
      (match[1] ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (entity: string, name: string) => {
          const named: Record<string, string> = {
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            amp: "&",
          };
          if (named[name] !== undefined) return named[name];
          // A number past the last code point stays as written.
          const code = Number(name.slice(1));
          return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
        })
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  return errors.length > 0 ? errors.join("; ") : null;
}

/**
 * What an error page says went wrong, as the error the caller gets: out of
 * time or memory as a timeout (a smaller area may work), the dispatcher's
 * rate limit as one, and the dispatcher refusing or failing to run the query
 * (`duplicate_query` among them) as unavailable. Anything else, a query
 * Overpass can't parse for one, keeps its text.
 */
function overpassErrorPageError(text: string): Error {
  if (/timed out|out of memory/i.test(text)) return new OverpassTimeoutError();
  if (/rate_limited/i.test(text)) return new OverpassRateLimitError();
  if (/Dispatcher|duplicate_query|runtime error/i.test(text)) {
    return new OverpassUnavailableError(text);
  }
  return new Error(`Overpass API error: ${text}`);
}

/**
 * How long to wait for an answer. Queries ask the server for 15–25 s; a busy
 * server can queue a query past that without answering at all.
 */
const OVERPASS_REQUEST_TIMEOUT_MS = 35_000;

async function fetchOverpass(url: string, query: string): Promise<OverpassResponse> {
  const contributors = snapshotContributors(captureSupplier(url));
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

    // A 200 that isn't JSON is Overpass's error page, never a SyntaxError.
    const body = await res.text();
    let parsed: OverpassResponse;
    try {
      parsed = JSON.parse(body) as OverpassResponse;
    } catch {
      const text = overpassErrorPageText(body);
      throw text
        ? overpassErrorPageError(text)
        : new Error("Overpass API answered with a body that is neither JSON nor an error page");
    }
    return { ...parsed, contributors };
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
