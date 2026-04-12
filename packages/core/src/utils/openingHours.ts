import type { nominatim_object } from "opening_hours";
import opening_hours from "opening_hours";

export interface DaySchedule {
  day: string;
  /** e.g. "09:00–17:00", "Closed", or "Open 24 hours" */
  hours: string;
  isToday: boolean;
}

export interface OpeningHoursStatus {
  isOpen: boolean;
  /** Full human-readable label, e.g. "Open now · Closes at 17:00" */
  label: string;
  /** The suffix portion only, e.g. "Closes at 17:00" or "Opens Mon at 09:00" */
  detail: string;
  todayHours?: string;
  /** Per-day schedule starting from today, used for the expandable hours row. */
  weekSchedule?: DaySchedule[];
  /** Comment from the opening_hours value, e.g. "by appointment" or a holiday name. */
  comment?: string;
  /** True if the schedule is the same every week (no seasonal or date-specific rules). */
  isWeekStable?: boolean;
  /** True when hours are ambiguous (e.g. "by appointment", cinema showtimes). */
  isUnknown?: boolean;
}

export interface LocationContext {
  lat: number;
  lon: number;
  countryCode?: string;
  state?: string;
}

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
