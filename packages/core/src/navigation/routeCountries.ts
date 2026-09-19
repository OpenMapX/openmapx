import type { MatchResult } from "../types/routing";

/**
 * Countries along the route, for the sign palette: road signs are coloured by
 * the country they stand in, so a trip across a border has to switch palettes
 * where it crosses rather than keep the origin's all the way. The countries
 * ride the route's windowed map-match, which navigation fetches anyway — no
 * request of their own.
 */

/** A stretch of the route in one country, from `fromMeters` to the next span. */
export interface RouteCountrySpan {
  fromMeters: number;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string;
}

/**
 * The country of each matched trace point of a map-match window, aligned 1:1
 * to `match.points` like `matchSpeedLimitsByPoint`. `null` where the point
 * matched no edge or the engine exposes no country.
 */
export function matchCountriesByPoint(match: MatchResult): (string | null)[] {
  return (match.points ?? []).map((point) => {
    if (point.edgeIndex === undefined) return null;
    return match.edges?.[point.edgeIndex]?.endNodeCountryCode ?? null;
  });
}

/**
 * Extend the spans with one window's per-point countries. `startIndex` is the
 * window's first `route.geometry` index and `cum` the route's cumulative
 * distances. Windows arrive in route order, so a span only opens where the
 * country differs from the last one known.
 */
export function appendCountrySpans(
  spans: RouteCountrySpan[],
  cum: number[],
  startIndex: number,
  countriesByPoint: (string | null)[],
): RouteCountrySpan[] {
  const next = [...spans];
  countriesByPoint.forEach((countryCode, j) => {
    const meters = cum[startIndex + j];
    if (!countryCode || meters === undefined) return;
    if (next.at(-1)?.countryCode === countryCode) return;
    next.push({ fromMeters: meters, countryCode });
  });
  return next;
}

/** The country at `meters` along the route; undefined before the first known span. */
export function countryAtMeters(spans: RouteCountrySpan[], meters: number): string | undefined {
  let found: string | undefined;
  for (const span of spans) {
    if (span.fromMeters > meters) break;
    found = span.countryCode;
  }
  return found;
}
