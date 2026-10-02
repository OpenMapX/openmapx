import tzLookup from "tz-lookup";

export { localDateInZone, zonedWallClockToInstant } from "./wallClock";

/**
 * IANA timezone name for a coordinate (e.g. `"Europe/Berlin"`), or `null` when
 * lookup fails. Thin wrapper over `tz-lookup` so consumers (including the web
 * app, which doesn't depend on `tz-lookup` directly) get timezone resolution
 * through `@openmapx/core`.
 */
export function timeZoneAt(lat: number, lng: number): string | null {
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

/**
 * Minutes east of UTC for `timeZone` at `date`, or `null` when `timeZone`
 * isn't a zone id the platform recognizes (an unresolved offset is not the
 * same fact as an actual UTC offset of 0, so unknown zones don't collapse to
 * 0 here). Vendored boundary data can carry a stale or malformed tzid, so
 * this degrades the way `zonedWallClockToInstant`/`timeZoneAt` above do
 * rather than throwing.
 */
export function tzOffsetMinutes(date: Date, timeZone: string): number | null {
  // Validated up front, independent of which `timeZoneName` variant works
  // below: a RangeError from the formatter can mean either "bad zone id" or
  // "unrecognized option value", and only the latter should fall through to
  // the shortOffset retry. Checking the zone id in isolation first means a
  // genuinely invalid id still returns null even with the retry in place.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return null;
  }

  // Safari 16.0-16.3 throws on "longOffset" (added later than "shortOffset").
  // shortOffset renders the same "GMT+H[:mm]" shape the regex below already
  // parses, just without longOffset's guaranteed leading zero/":00" minutes,
  // so no separate parsing path is needed for the fallback.
  let formatted: string | null = null;
  for (const timeZoneName of ["longOffset", "shortOffset"] as const) {
    try {
      formatted = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName }).format(date);
      break;
    } catch {
      // Try the next variant.
    }
  }
  if (formatted === null) return null;

  const signed = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(formatted);
  if (signed) {
    const sign = signed[1] === "-" ? -1 : 1;
    return sign * (Number(signed[2]) * 60 + Number(signed[3] ?? 0));
  }

  // V8 always renders a zero offset as "GMT+00:00"/"GMT+0", but CLDR's
  // `gmtZeroFormat` for `en` is a bare "GMT" (no sign, no digits), which some
  // engines use verbatim for the localized-GMT `timeZoneName` variants this
  // function requests. Accept that as zero rather than degrading to null, but
  // only as a standalone word so an unrelated, genuinely unparseable string
  // can't collapse to zero.
  //
  // Deliberately not matching "UTC" here: unlike "GMT", there's no confirmed
  // engine whose gmtZeroFormat renders it, and `\bUTC\b` would also match
  // inside a *signed* string like "UTC+02:00" (`\b` matches right before the
  // `+`) if some engine used "UTC" as the offset prefix instead of "GMT" —
  // silently parsing every non-zero offset as zero. A speculative branch that
  // can produce a confidently wrong answer is worse than the null it would
  // replace.
  if (/\bGMT\b/.test(formatted)) return 0;

  return null;
}

/**
 * Human offset label, e.g. "UTC+2", "UTC+5:45", "UTC-5", or "UTC" at zero.
 * `null` propagates from an unrecognized `timeZone`.
 */
export function tzOffsetLabel(date: Date, timeZone: string): string | null {
  const minutes = tzOffsetMinutes(date, timeZone);
  if (minutes === null) return null;
  if (minutes === 0) return "UTC";

  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;

  return remainder === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(remainder).padStart(2, "0")}`;
}

/** The viewer's own IANA zone, as the platform resolves it. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Signed minutes `to` is ahead of `from` at `date`, or `null` when either
 * zone is unrecognized.
 */
export function tzDiffMinutes(date: Date, from: string, to: string): number | null {
  const fromMinutes = tzOffsetMinutes(date, from);
  const toMinutes = tzOffsetMinutes(date, to);
  if (fromMinutes === null || toMinutes === null) return null;
  return toMinutes - fromMinutes;
}

/**
 * The 24-hour wall clock in `timeZone` at `date`, or `null` when `timeZone`
 * isn't a zone id the platform recognizes.
 */
export function formatInTimeZone(date: Date, timeZone: string, locale?: string): string | null {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return null;
  }
}

/**
 * The instant rendered in `timeZone` as ISO-8601 carrying that zone's offset,
 * e.g. `2026-09-02T14:30:00+02:00`. Callers render schedules across several
 * zones, so the offset has to travel with the string rather than being implied
 * by the reader's locale. An unrecognized zone degrades to `+00:00`, matching
 * how the other helpers here treat a bad zone id.
 */
export function isoWithOffsetInZone(date: Date, timeZone: string): string {
  const offset = tzOffsetMinutes(date, timeZone) ?? 0;
  const shifted = new Date(date.getTime() + offset * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const calendar = `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${pad(
    shifted.getUTCMonth() + 1,
  )}-${pad(shifted.getUTCDate())}`;
  const clock = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}`;
  return `${calendar}T${clock}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
