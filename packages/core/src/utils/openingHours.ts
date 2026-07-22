// SERVER-ONLY. This module imports the LGPL-3 `opening_hours` package and must
// never be reached by the client bundle. Pure types live in
// `../types/openingHoursInfo.ts` (re-exported below) so client code can refer
// to the shapes without pulling in this runtime.

import type { nominatim_object } from "opening_hours";
import opening_hours from "opening_hours";
import tzLookup from "tz-lookup";
import type {
  DaySchedule,
  LocationContext,
  OpeningHoursChange,
  OpeningHoursInfo,
  OpeningHoursStatus,
  OpeningInterval,
} from "../types/openingHoursInfo";

export type {
  DaySchedule,
  LocationContext,
  OpeningHoursChange,
  OpeningHoursInfo,
  OpeningHoursStatus,
  OpeningInterval,
} from "../types/openingHoursInfo";

function buildNominatim(loc?: LocationContext): nominatim_object | undefined {
  if (!loc?.countryCode) return undefined;
  return {
    lat: loc.lat,
    lon: loc.lon,
    address: {
      country_code: loc.countryCode,
      state: loc.state ?? "",
    },
  };
}

/**
 * "Now" expressed in the place's local wall-clock, encoded so that the
 * `opening_hours` library — which reads a Date's *local* fields (getHours/
 * getDay) — sees the place's time rather than the server's.
 *
 * The server runs in UTC, but we don't rely on that: the returned Date's local
 * fields equal the place's wall-clock regardless of the runtime timezone,
 * because we add back the runtime's own offset. All downstream Dates the
 * library derives from this value (next-change, intervals) stay in the same
 * frame, so `fmt()` and day comparisons remain internally consistent.
 *
 * Falls back to the real `new Date()` when the timezone can't be resolved.
 */
function placeNow(location?: LocationContext): Date {
  const real = new Date();
  if (!location) return real;
  let tz: string;
  try {
    tz = tzLookup(location.lat, location.lon);
  } catch {
    return real; // coordinates outside the tz dataset (e.g. open ocean)
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(real);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") % 24; // Intl can emit "24" at midnight
  const wallClockUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return new Date(wallClockUtc + real.getTimezoneOffset() * 60_000);
}

function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Upper bound for `getNextChange`. The library's iterator has no natural
 * stopping point for a rule that never changes state but still has recurring
 * date boundaries — `Mo-Su, PH 00:00-24:00` is always open, yet gets
 * re-evaluated at every public holiday. Unbounded, it walks centuries ahead
 * (~100s of CPU) until the holiday arithmetic gives out and throws, which used
 * to surface as a bogus "Closed".
 *
 * A year is a complete horizon: rules repeat annually, so anything that ever
 * changes state does so within one. Nothing beyond it is worth reporting —
 * "no change within a year" is exactly the always-open/always-closed case.
 */
function changeHorizon(now: Date): Date {
  const limit = new Date(now);
  limit.setFullYear(limit.getFullYear() + 1);
  return limit;
}

function nextChangeWithin(oh: opening_hours, now: Date): Date | undefined {
  return oh.getNextChange(now, changeHorizon(now));
}

/**
 * Builds a 7-day schedule starting from today using the library's interval API.
 * Spans stay as wall-clock strings — the client turns them into text.
 */
function buildWeekSchedule(oh: opening_hours, now: Date): DaySchedule[] {
  const schedule: DaySchedule[] = [];

  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(now);
    dayStart.setDate(now.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    const intervals = oh.getOpenIntervals(dayStart, dayEnd);

    // Drop intervals in "unknown" state (ambiguous hours like "by appointment"
    // or cinema showtimes) so they don't display as definite
    const definite = intervals.filter(([start]) => {
      const t = new Date(Math.max(start.getTime(), dayStart.getTime()));
      return !oh.getUnknown(t);
    });

    // Clamp spans that run past midnight to the day they're listed under.
    const spans: OpeningInterval[] = definite.map(([start, end]) => ({
      from: start < dayStart ? "00:00" : fmt(start),
      to: end >= dayEnd ? "24:00" : fmt(end),
    }));

    schedule.push({
      weekday: dayStart.getDay(),
      intervals: spans,
      isToday: i === 0,
    });
  }

  return schedule;
}

/** Describes the upcoming flip relative to the place's own today. */
function describeChange(nextChange: Date, now: Date, isOpen: boolean): OpeningHoursChange {
  const weekday = nextChange.getDay();
  const todayIdx = now.getDay();
  const day =
    weekday === todayIdx ? "today" : weekday === (todayIdx + 1) % 7 ? "tomorrow" : "other";
  return { kind: isOpen ? "closes" : "opens", at: fmt(nextChange), weekday, day };
}

/**
 * Parses an OSM `opening_hours` string and returns current open/closed status.
 * Uses the `opening_hours` library for full OSM spec support including
 * public holidays, seasonal hours, sunrise/sunset, comments, and more.
 */
export function parseOpeningHours(
  raw: string | undefined,
  location?: LocationContext,
): OpeningHoursStatus | null {
  if (!raw) return null;

  try {
    const oh = new opening_hours(raw, buildNominatim(location));
    const now = placeNow(location);
    const isOpen = oh.getState(now);
    const isUnknown = oh.getUnknown(now);
    const comment = oh.getComment(now);
    const nextChange = nextChangeWithin(oh, now);

    // When the current state is unknown (ambiguous hours like "by appointment",
    // cinema showtimes, etc.), don't state a definitive "Open" or "Closed"
    if (isUnknown) {
      return {
        isOpen: false,
        isUnknown: true,
        text: comment || raw,
        comment: comment ?? undefined,
        isWeekStable: oh.isWeekStable(),
      };
    }

    return {
      isOpen,
      // Absent when nothing changes within a year: always open, or always closed.
      nextChange: nextChange ? describeChange(nextChange, now, isOpen) : undefined,
      weekSchedule: buildWeekSchedule(oh, now),
      comment: comment ?? undefined,
      isWeekStable: oh.isWeekStable(),
    };
  } catch {
    // Unevaluable opening_hours value — malformed syntax, or a selector we
    // can't resolve here (a `PH` rule needs a country code we may not have).
    // Show the raw value rather than a definite "Closed" we can't stand behind.
    return { isOpen: false, isUnknown: true, text: raw };
  }
}

/**
 * Returns whether a place is open at a specific date/time.
 */
export function isOpenAt(raw: string | undefined, date: Date, location?: LocationContext): boolean {
  if (!raw) return false;
  try {
    const oh = new opening_hours(raw, buildNominatim(location));
    return oh.getState(date) && !oh.getUnknown(date);
  } catch {
    return false;
  }
}

/**
 * Returns whether a place is always open (24/7 or semantically equivalent).
 */
export function isAlwaysOpen(raw: string | undefined, location?: LocationContext): boolean {
  if (!raw) return false;
  try {
    const oh = new opening_hours(raw, buildNominatim(location));
    return alwaysOpen(oh, placeNow(location));
  } catch {
    return false;
  }
}

/** Open right now with no state change ahead — i.e. 24/7 or equivalent. */
function alwaysOpen(oh: opening_hours, now: Date): boolean {
  return oh.getState(now) && nextChangeWithin(oh, now) === undefined;
}

/**
 * Builds a 168-bit (7×24) hex-encoded bitmap. Each bit `dayIdx * 24 + hour`
 * is set when the place is open at the NEXT occurrence of (dayIdx, hour)
 * from `now` — slots earlier this week roll forward to next week. Used to
 * satisfy the client-side "open at X" filter without shipping the LGPL
 * `opening_hours` library to the browser.
 *
 * Anchoring to "next occurrence" matters for date-dependent rules: with a
 * Sunday-anchored week, a Friday user filtering for Monday would have read
 * last Monday's state (e.g. wrong side of a `PH off` boundary or a one-day
 * exception). Forward-only evaluation matches the prior behavior the
 * client filter expects.
 */
function buildWeekBitmap(oh: opening_hours, now: Date): string {
  const bits = new Uint8Array(21);
  const nowDay = now.getDay();
  const nowHour = now.getHours();

  for (let i = 0; i < 168; i++) {
    const dayIdx = Math.floor(i / 24);
    const hour = i % 24;
    // Roll same-day slots whose hour has already passed forward by a week
    // so the bit always represents a future state. `hour <= nowHour` covers
    // the current hour too — "open_now" is its own filter, so an "open_at"
    // pick of today's current hour is forward-looking by intent.
    let daysAhead = (dayIdx - nowDay + 7) % 7;
    if (daysAhead === 0 && hour <= nowHour) daysAhead = 7;
    const t = new Date(now);
    t.setDate(t.getDate() + daysAhead);
    t.setHours(hour, 0, 0, 0);
    try {
      if (oh.getState(t) && !oh.getUnknown(t)) {
        const byteIdx = i >> 3;
        const bitInByte = 7 - (i & 7); // MSB-first
        const cur = bits[byteIdx] ?? 0;
        bits[byteIdx] = cur | (1 << bitInByte);
      }
    } catch {
      // Ignore hour-level evaluation errors; leave bit at 0.
    }
  }

  let hex = "";
  for (const b of bits) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Server-side builder for the precomputed `OpeningHoursInfo` attached to API
 * responses. Always evaluated on the server so the LGPL-3 `opening_hours`
 * library never ships to the browser.
 */
export function buildOpeningHoursInfo(
  raw: string | undefined,
  location?: LocationContext,
): OpeningHoursInfo | undefined {
  if (!raw) return undefined;
  const status = parseOpeningHours(raw, location);
  let always = false;
  let weekBitmap = "";
  try {
    const oh = new opening_hours(raw, buildNominatim(location));
    const now = placeNow(location);
    always = alwaysOpen(oh, now);
    weekBitmap = buildWeekBitmap(oh, now);
  } catch {
    // Leave defaults — status already reflects the parse failure.
  }
  return { status, isAlwaysOpen: always, weekBitmap };
}
