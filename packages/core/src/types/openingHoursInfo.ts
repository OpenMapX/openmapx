// Pure-type module — kept separate from `../utils/openingHours.ts` so the
// LGPL-3 `opening_hours` runtime never enters the dependency graph of any
// browser bundle. Server code that needs the builder imports from
// `../utils/openingHours`; client/shared code only references the types here.

/**
 * A span the place is open, as local wall-clock "HH:MM". `to` may be "24:00"
 * to mean end-of-day. Rendered client-side so the user's 12h/24h preference
 * and locale apply.
 */
export interface OpeningInterval {
  from: string;
  to: string;
}

export interface DaySchedule {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Open spans for the day; empty means closed all day. */
  intervals: OpeningInterval[];
  isToday: boolean;
}

/**
 * The upcoming open/closed flip. `day` is relative to the place's own today so
 * the client can pick between "at 17:00", "tomorrow at 17:00" and naming the
 * weekday, without re-deriving the place's calendar.
 */
export interface OpeningHoursChange {
  kind: "opens" | "closes";
  /** Local wall-clock "HH:MM". */
  at: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  day: "today" | "tomorrow" | "other";
}

/**
 * Current status as data, never as prose. Every user-facing string is built in
 * the client from these fields (see `useOpeningHoursText` in the web app) so
 * the panel follows the active locale and the Settings time-format preference.
 */
export interface OpeningHoursStatus {
  isOpen: boolean;
  /** Absent when nothing changes within a year — i.e. always open or always closed. */
  nextChange?: OpeningHoursChange;
  /** Per-day schedule starting from today, used for the expandable hours row. */
  weekSchedule?: DaySchedule[];
  /** Comment from the opening_hours value, e.g. "by appointment" or a holiday name. */
  comment?: string;
  /** True if the schedule is the same every week (no seasonal or date-specific rules). */
  isWeekStable?: boolean;
  /**
   * True when the hours can't be stated definitively — ambiguous values like
   * "by appointment", or a value we failed to evaluate at all. Show `text`
   * rather than an open/closed verdict.
   */
  isUnknown?: boolean;
  /** Free text for the `isUnknown` case: the comment, else the raw OSM value. */
  text?: string;
}

export interface LocationContext {
  lat: number;
  lon: number;
  countryCode?: string;
  state?: string;
}

/**
 * Server-precomputed opening-hours data attached to API responses so the web
 * client can render and filter without bundling the LGPL `opening_hours`
 * library. Always built on the server — see `buildOpeningHoursInfo` in
 * `../utils/openingHours.ts`.
 */
export interface OpeningHoursInfo {
  /** Current status as structured data. Null when there is no raw value. */
  status: OpeningHoursStatus | null;
  /** True iff the place is open 24/7 (no upcoming state change). */
  isAlwaysOpen: boolean;
  /**
   * 7×24 bitmap of open hours starting at Sunday 00:00 of the week containing
   * `now`, encoded as 42 hex chars (168 bits, MSB-first within each byte).
   * Used by the client "open at <day, hour>" filter as a pure lookup.
   * Empty string if the schedule could not be computed.
   */
  weekBitmap: string;
}
