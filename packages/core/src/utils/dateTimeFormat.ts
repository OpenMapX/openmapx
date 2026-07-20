/**
 * User-selectable date/time formatting.
 *
 * The app exposes a Settings preference for how wall-clock times and calendar
 * dates are rendered (see `settingsStore`). These pure helpers map that
 * preference to a concrete string; the web app consumes them reactively through
 * the `useDateTimeFormat` hook, but they're framework-free so they can be unit
 * tested and reused (e.g. mobile) without React.
 *
 * "auto" follows the active locale's own convention (the historical behavior),
 * so it never changes how anything looked before a user opts into an override.
 */

/** Clock-time rendering preference. */
export type TimeFormat = "auto" | "12h" | "24h";

/** Calendar-date rendering preference (order + separator). */
export type DateFormat = "auto" | "dmy" | "mdy" | "ymd";

export interface ClockTimeOptions {
  locale?: string;
  timeFormat?: TimeFormat;
  /** IANA time zone (e.g. a station's local zone); defaults to the runtime zone. */
  timeZone?: string;
}

export interface CalendarDateOptions {
  locale?: string;
  dateFormat?: DateFormat;
  timeZone?: string;
}

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map the time preference to an Intl `hour12` flag (`undefined` = locale default). */
function hour12For(timeFormat: TimeFormat | undefined): boolean | undefined {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return undefined;
}

/** Format a timestamp as a short wall-clock time (hour + minute) per preference. */
export function formatClockTime(
  value: string | number | Date,
  { locale, timeFormat = "auto", timeZone }: ClockTimeOptions = {},
): string {
  const d = toDate(value);
  if (!d) return "";
  const hour12 = hour12For(timeFormat);
  return d.toLocaleTimeString(locale ?? [], {
    hour: "2-digit",
    minute: "2-digit",
    ...(hour12 !== undefined ? { hour12 } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Extract zero-padded year/month/day parts in the given zone (locale-independent). */
function numericDateParts(
  d: Date,
  timeZone?: string,
): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Format a timestamp as a numeric calendar date per preference. */
export function formatCalendarDate(
  value: string | number | Date,
  { locale, dateFormat = "auto", timeZone }: CalendarDateOptions = {},
): string {
  const d = toDate(value);
  if (!d) return "";
  if (dateFormat === "auto") {
    return d.toLocaleDateString(locale ?? [], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  }
  const { year, month, day } = numericDateParts(d, timeZone);
  switch (dateFormat) {
    case "dmy":
      return `${day}.${month}.${year}`;
    case "mdy":
      return `${month}/${day}/${year}`;
    case "ymd":
      return `${year}-${month}-${day}`;
  }
}

/** Format a timestamp as a date followed by a wall-clock time, both per preference. */
export function formatDateAndTime(
  value: string | number | Date,
  options: ClockTimeOptions & CalendarDateOptions = {},
): string {
  const date = formatCalendarDate(value, options);
  const time = formatClockTime(value, options);
  if (!date || !time) return date || time;
  return `${date}, ${time}`;
}

export interface RelativeTimeOptions {
  locale?: string;
  /** Reference instant "now" is measured from. Defaults to `Date.now()`; tests pin this. */
  now?: number;
}

// Largest-unit-first so a 2-day-old timestamp reads "2 days ago" rather than
// "2880 minutes ago". "second" is last and always matches (its own
// threshold is 1), so the loop always terminates.
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** Format a timestamp as a locale-aware relative time (e.g. "5 minutes ago"). */
export function formatRelativeTime(
  value: string | number | Date,
  { locale, now }: RelativeTimeOptions = {},
): string {
  const d = toDate(value);
  if (!d) return "";
  const diffSeconds = Math.round((d.getTime() - (now ?? Date.now())) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale ?? [], { numeric: "auto" });
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit || unit === "second") {
      return rtf.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return rtf.format(diffSeconds, "second");
}
