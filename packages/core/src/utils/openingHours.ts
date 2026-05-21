// SERVER-ONLY. This module imports the LGPL-3 `opening_hours` package and must
// never be reached by the client bundle. Pure types live in
// `../types/openingHoursInfo.ts` (re-exported below) so client code can refer
// to the shapes without pulling in this runtime.

import type { nominatim_object } from "opening_hours";
import opening_hours from "opening_hours";
import type {
  DaySchedule,
  LocationContext,
  OpeningHoursInfo,
  OpeningHoursStatus,
} from "../types/openingHoursInfo";

export type {
  DaySchedule,
  LocationContext,
  OpeningHoursInfo,
  OpeningHoursStatus,
} from "../types/openingHoursInfo";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Builds a 7-day schedule starting from today using the library's interval API.
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
    const dayIdx = dayStart.getDay();

    // Filter out intervals in "unknown" state (ambiguous hours like
    // "by appointment" or cinema showtimes) so they don't display as definite
    const definiteIntervals = intervals.filter(([start]) => {
      const t = new Date(Math.max(start.getTime(), dayStart.getTime()));
      return !oh.getUnknown(t);
    });

    let hours: string;
    if (definiteIntervals.length === 0) {
      hours = "Closed";
    } else {
      const parts = definiteIntervals.map(([start, end]) => {
        const s = start < dayStart ? "00:00" : fmt(start);
        const e = end >= dayEnd ? "24:00" : fmt(end);
        if (s === "00:00" && e === "24:00") return "Open 24 hours";
        return `${s}–${e}`;
      });
      hours = parts.includes("Open 24 hours") ? "Open 24 hours" : parts.join(", ");
    }

    schedule.push({
      day: FULL_DAY_NAMES[dayIdx],
      hours,
      isToday: i === 0,
    });
  }

  return schedule;
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
    const now = new Date();
    const isOpen = oh.getState(now);
    const isUnknown = oh.getUnknown(now);
    const comment = oh.getComment(now);
    const nextChange = oh.getNextChange(now);

    // When the current state is unknown (ambiguous hours like "by appointment",
    // cinema showtimes, etc.), don't show a definitive "Open" or "Closed" status
    if (isUnknown) {
      const unknownDetail = comment || raw;
      return {
        isOpen: false,
        isUnknown: true,
        label: unknownDetail,
        detail: unknownDetail,
        comment: comment ?? undefined,
        isWeekStable: oh.isWeekStable(),
      };
    }

    const effectiveOpen = isOpen;

    // Build detail string based on next state change
    let detail: string;
    if (nextChange) {
      const changeDay = nextChange.getDay();
      const todayIdx = now.getDay();
      const tomorrowIdx = (todayIdx + 1) % 7;
      const timeStr = fmt(nextChange);

      if (effectiveOpen) {
        if (changeDay === todayIdx) {
          detail = `Closes at ${timeStr}`;
        } else if (changeDay === tomorrowIdx) {
          detail = `Closes tomorrow at ${timeStr}`;
        } else {
          detail = `Closes ${DAY_NAMES[changeDay]} at ${timeStr}`;
        }
      } else {
        if (changeDay === todayIdx) {
          detail = `Opens at ${timeStr}`;
        } else if (changeDay === tomorrowIdx) {
          detail = `Opens tomorrow at ${timeStr}`;
        } else {
          detail = `Opens ${DAY_NAMES[changeDay]} at ${timeStr}`;
        }
      }
    } else {
      // No next change — either always open or permanently closed
      detail = effectiveOpen ? "Open 24 hours" : "Closed";
    }

    // Append comment if present
    if (comment) {
      detail = `${detail} (${comment})`;
    }

    const label = effectiveOpen ? `Open now · ${detail}` : `Closed · ${detail}`;

    // Build week schedule
    const weekSchedule = buildWeekSchedule(oh, now);

    // Today's hours summary
    const todayEntry = weekSchedule[0];
    const todayHours = todayEntry?.hours === "Closed" ? "Closed today" : todayEntry?.hours;

    return {
      isOpen: effectiveOpen,
      label,
      detail,
      todayHours,
      weekSchedule,
      comment: comment ?? undefined,
      isWeekStable: oh.isWeekStable(),
    };
  } catch {
    // Malformed opening_hours string — fall back to displaying raw value
    return { isOpen: false, label: raw, detail: raw };
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
    return oh.getState() && oh.getNextChange() === undefined;
  } catch {
    return false;
  }
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
    always = oh.getState() && oh.getNextChange() === undefined;
    weekBitmap = buildWeekBitmap(oh, new Date());
  } catch {
    // Leave defaults — status already reflects the parse failure.
  }
  return { status, isAlwaysOpen: always, weekBitmap };
}
