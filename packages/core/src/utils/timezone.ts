import tzLookup from "tz-lookup";

type WallClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function partsAt(timeZone: string, instantMs: number): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function compareWallClock(left: WallClockParts, right: WallClockParts): number {
  for (const key of ["year", "month", "day", "hour", "minute", "second"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

/** Minutes `timeZone` is ahead of UTC at the given instant (DST-aware). */
function timeZoneOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utcMs));
  const label = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = label.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/**
 * Resolves a local wall clock in an IANA timezone to an absolute instant.
 * Ambiguous times choose the earlier instant. Missing times (DST gaps) choose
 * the earliest valid instant at or after the requested wall clock.
 */
export function zonedWallClockToInstant(timeZone: string, wallClock: string): Date | null {
  const match = wallClock.match(WALL_CLOCK_PATTERN);
  if (!match) return null;

  const requested: WallClockParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const naiveMs = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
  );
  const normalized = new Date(naiveMs);
  if (
    normalized.getUTCFullYear() !== requested.year ||
    normalized.getUTCMonth() + 1 !== requested.month ||
    normalized.getUTCDate() !== requested.day ||
    normalized.getUTCHours() !== requested.hour ||
    normalized.getUTCMinutes() !== requested.minute ||
    normalized.getUTCSeconds() !== requested.second
  ) {
    return null;
  }

  try {
    const offsets = new Set<number>();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      offsets.add(timeZoneOffsetMinutes(timeZone, naiveMs + hours * 3_600_000));
    }

    const exact = [...offsets]
      .map((offset) => naiveMs - offset * 60_000)
      .filter((candidate) => compareWallClock(partsAt(timeZone, candidate), requested) === 0)
      .sort((a, b) => a - b);
    if (exact[0] !== undefined) return new Date(exact[0]);

    // The local wall clock is in a timezone discontinuity. Search only the
    // narrow transition window around the offset-derived candidates.
    const candidates = [...offsets].map((offset) => naiveMs - offset * 60_000);
    const start = Math.min(...candidates) - 3 * 3_600_000;
    const end = Math.max(...candidates) + 3 * 3_600_000;
    const stepMs = requested.second === 0 ? 60_000 : 1_000;
    for (let instantMs = start; instantMs <= end; instantMs += stepMs) {
      const local = partsAt(timeZone, instantMs);
      if (
        local.year === requested.year &&
        local.month === requested.month &&
        local.day === requested.day &&
        compareWallClock(local, requested) >= 0
      ) {
        return new Date(instantMs);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function localDateInZone(at: Date, timeZone: string): string {
  const parts = partsAt(timeZone, at.getTime());
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

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
