// Pure-type module — kept separate from `../utils/openingHours.ts` so the
// LGPL-3 `opening_hours` runtime never enters the dependency graph of any
// browser bundle. Server code that needs the builder imports from
// `../utils/openingHours`; client/shared code only references the types here.

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

/**
 * Server-precomputed opening-hours data attached to API responses so the web
 * client can render and filter without bundling the LGPL `opening_hours`
 * library. Always built on the server — see `buildOpeningHoursInfo` in
 * `../utils/openingHours.ts`.
 */
export interface OpeningHoursInfo {
  /** Display-ready current status. Null when the raw value is unparseable. */
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
