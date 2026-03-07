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
}

// Maps OSM day abbreviations to JS getDay() values (0 = Sunday)
const DAY_INDEX: Record<string, number> = {
  Su: 0,
  Mo: 1,
  Tu: 2,
  We: 3,
  Th: 4,
  Fr: 5,
  Sa: 6,
};

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

/** Expands "Mo-Fr" or "Mo" into a Set of JS day indices. */
function expandDays(spec: string): Set<number> {
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^([A-Z][a-z])-([A-Z][a-z])$/);
    if (range) {
      const start = DAY_INDEX[range[1]];
      const end = DAY_INDEX[range[2]];
      if (start !== undefined && end !== undefined) {
        let d = start;
        while (true) {
          days.add(d);
          if (d === end) break;
          d = (d + 1) % 7;
        }
      }
    } else {
      const idx = DAY_INDEX[trimmed];
      if (idx !== undefined) days.add(idx);
    }
  }
  return days;
}

/** Compares two "HH:MM" strings. Returns negative/zero/positive. */
function cmpTime(a: string, b: string): number {
  return a.localeCompare(b);
}

interface Segment {
  days: Set<number>;
  open: string;
  close: string;
}

/** Parses an OSM opening_hours string into time segments. */
function parseSegments(raw: string): Segment[] {
  const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
  const segments: Segment[] = [];

  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    // "Mo-Fr 10:00-19:00" (trailing + means "or later", ignored)
    const withDays = trimmed.match(/^([\w,\s-]+?)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\+?$/);
    if (withDays) {
      const [, daySpec, open, close] = withDays;
      segments.push({
        days: expandDays(daySpec.trim()),
        open,
        close: close === "00:00" ? "24:00" : close,
      });
      continue;
    }
    // "10:00-19:00" with no day spec — every day
    const timeOnly = trimmed.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})\+?$/);
    if (timeOnly) {
      const [, open, close] = timeOnly;
      segments.push({
        days: ALL_DAYS,
        open,
        close: close === "00:00" ? "24:00" : close,
      });
    }
  }

  return segments;
}

/**
 * Returns whether a place is open on a specific day at a specific hour.
 * Pass null for dayIdx or hour to mean "any day" / "any time".
 */
export function isOpenAt(
  raw: string | undefined,
  dayIdx: number | null,
  hour: number | null,
): boolean {
  if (!raw) return false;
  if (dayIdx === null && hour === null) return true;
  if (raw === "24/7") return true;

  const segments = parseSegments(raw);
  const timeStr = hour !== null ? `${String(hour).padStart(2, "0")}:00` : null;

  if (dayIdx !== null && timeStr !== null) {
    // Specific day + time
    const seg = segments.find((s) => s.days.has(dayIdx));
    if (!seg) return false;
    return cmpTime(timeStr, seg.open) >= 0 && cmpTime(timeStr, seg.close) < 0;
  }

  if (dayIdx !== null) {
    // Open on this day at any time
    return segments.some((s) => s.days.has(dayIdx));
  }

  // Open at this time on any day
  if (!timeStr) return false;
  return segments.some((seg) => cmpTime(timeStr, seg.open) >= 0 && cmpTime(timeStr, seg.close) < 0);
}

/**
 * Parses an OSM `opening_hours` string and returns current open/closed status.
 * Handles the common `Mo-Fr 09:00-17:00; Sa 10:00-14:00` patterns.
 * Falls back to showing the raw string on any parse failure.
 */
export function parseOpeningHours(raw: string | undefined): OpeningHoursStatus | null {
  if (!raw) return null;

  const now = new Date();
  const todayIdx = now.getDay();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  if (raw === "24/7") {
    const weekSchedule: DaySchedule[] = Array.from({ length: 7 }, (_, i) => ({
      day: FULL_DAY_NAMES[(todayIdx + i) % 7],
      hours: "Open 24 hours",
      isToday: i === 0,
    }));
    return {
      isOpen: true,
      label: "Open 24 hours",
      detail: "Open 24 hours",
      todayHours: "24/7",
      weekSchedule,
    };
  }

  const segments = parseSegments(raw);

  if (segments.length === 0) {
    return { isOpen: false, label: raw, detail: raw };
  }

  // Per-day schedule starting from today (for the expandable row)
  const weekSchedule: DaySchedule[] = Array.from({ length: 7 }, (_, i) => {
    const dayIdx = (todayIdx + i) % 7;
    const seg = segments.find((s) => s.days.has(dayIdx));
    return {
      day: FULL_DAY_NAMES[dayIdx],
      hours: seg ? `${seg.open}–${seg.close}` : "Closed",
      isToday: i === 0,
    };
  });

  const todaySeg = segments.find((s) => s.days.has(todayIdx));

  if (todaySeg) {
    const isOpen =
      cmpTime(currentTime, todaySeg.open) >= 0 && cmpTime(currentTime, todaySeg.close) < 0;

    if (isOpen) {
      const detail = `Closes at ${todaySeg.close}`;
      return {
        isOpen: true,
        label: `Open now · ${detail}`,
        detail,
        todayHours: `${todaySeg.open}–${todaySeg.close}`,
        weekSchedule,
      };
    }

    if (cmpTime(currentTime, todaySeg.open) < 0) {
      const detail = `Opens at ${todaySeg.open}`;
      return {
        isOpen: false,
        label: `Closed · ${detail}`,
        detail,
        todayHours: `${todaySeg.open}–${todaySeg.close}`,
        weekSchedule,
      };
    }

    for (let i = 1; i <= 7; i++) {
      const nextIdx = (todayIdx + i) % 7;
      const nextSeg = segments.find((s) => s.days.has(nextIdx));
      if (nextSeg) {
        const detail = `Opens ${DAY_NAMES[nextIdx]} at ${nextSeg.open}`;
        return {
          isOpen: false,
          label: `Closed · ${detail}`,
          detail,
          todayHours: `${todaySeg.open}–${todaySeg.close}`,
          weekSchedule,
        };
      }
    }
  }

  for (let i = 1; i <= 7; i++) {
    const nextIdx = (todayIdx + i) % 7;
    const nextSeg = segments.find((s) => s.days.has(nextIdx));
    if (nextSeg) {
      const detail = `Opens ${DAY_NAMES[nextIdx]} at ${nextSeg.open}`;
      return {
        isOpen: false,
        label: `Closed · ${detail}`,
        detail,
        todayHours: "Closed today",
        weekSchedule,
      };
    }
  }

  return { isOpen: false, label: raw, detail: raw };
}
