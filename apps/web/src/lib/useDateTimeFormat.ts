"use client";

import {
  formatCalendarDate,
  formatClockTime,
  formatDateAndTime,
  formatRelativeTime,
  useSettingsStore,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useMemo } from "react";

interface FormatOpts {
  /** IANA time zone (e.g. a station's local zone); defaults to the runtime zone. */
  timeZone?: string;
}

export interface DateTimeFormatters {
  /** Short wall-clock time (hour + minute) per the user's time-format preference. */
  time: (value: string | number | Date, opts?: FormatOpts) => string;
  /** Numeric calendar date per the user's date-format preference. */
  date: (value: string | number | Date, opts?: FormatOpts) => string;
  /** Date followed by time, both per preference. */
  dateTime: (value: string | number | Date, opts?: FormatOpts) => string;
  /** Locale-aware relative time (e.g. "5 minutes ago" / "vor 5 Minuten"). */
  relative: (value: string | number | Date) => string;
}

/**
 * Reactive date/time formatters bound to the active locale and the user's
 * Settings preferences (`timeFormat`/`dateFormat`). Re-renders consumers when
 * the preference changes. Use this for any user-facing wall-clock time or
 * calendar date so the Settings → Time/Date format choice takes effect.
 */
export function useDateTimeFormat(): DateTimeFormatters {
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  return useMemo<DateTimeFormatters>(
    () => ({
      time: (value, opts) =>
        formatClockTime(value, { locale, timeFormat, timeZone: opts?.timeZone }),
      date: (value, opts) =>
        formatCalendarDate(value, { locale, dateFormat, timeZone: opts?.timeZone }),
      dateTime: (value, opts) =>
        formatDateAndTime(value, { locale, timeFormat, dateFormat, timeZone: opts?.timeZone }),
      relative: (value) => formatRelativeTime(value, { locale }),
    }),
    [locale, timeFormat, dateFormat],
  );
}
