/**
 * Shared helpers for concrete weather providers.
 *
 * Anything generic enough to appear in 2+ providers lives here — provider-
 * specific URL builders, response parsers, and symbol-code → WMO maps stay
 * in each provider because every upstream uses a different vocabulary.
 */

import { fetchJson, type LngLat, timeZoneAt } from "@openmapx/core";

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
  return fetchJson<T>(url, { timeoutMs, headers, label });
}

/**
 * The IANA zone whose calendar days a daily forecast for `coords` reports, or
 * `"UTC"` when the coordinate has no zone the platform recognizes.
 */
export function forecastTimeZone(coords: LngLat): string {
  const zone = timeZoneAt(coords[1], coords[0]);
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

export interface LocalDay<T> {
  /** Calendar date in the grouping zone, `YYYY-MM-DD`. */
  date: string;
  /** The day's records, in input order. */
  records: T[];
  /** The record nearest local noon by wall clock; on a tie, the later one. */
  noon: T;
}

const NOON_MINUTE = 12 * 60;

/**
 * Groups time-stamped records by the calendar date of their instant in
 * `timeZone`, in order of first appearance. A day on which daylight saving time
 * starts or ends keeps all of its 23 or 25 hours. Records whose time cannot be
 * read are skipped.
 */
export function groupByLocalDay<T>(
  records: readonly T[],
  instantOf: (record: T) => string | number,
  timeZone: string,
): LocalDay<T>[] {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const days = new Map<string, LocalDay<T> & { noonDistance: number }>();
  for (const record of records) {
    const instant = instantOf(record);
    const ms = typeof instant === "number" ? instant : Date.parse(instant);
    if (!Number.isFinite(ms)) continue;
    const parts = format.formatToParts(new Date(ms));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const noonDistance = Math.abs(Number(part("hour")) * 60 + Number(part("minute")) - NOON_MINUTE);
    const day = days.get(date);
    if (!day) {
      days.set(date, { date, records: [record], noon: record, noonDistance });
      continue;
    }
    day.records.push(record);
    if (noonDistance <= day.noonDistance) {
      day.noon = record;
      day.noonDistance = noonDistance;
    }
  }
  return [...days.values()].map(({ date, records: dayRecords, noon }) => ({
    date,
    records: dayRecords,
    noon,
  }));
}
