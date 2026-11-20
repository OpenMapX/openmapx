"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import {
  type DateTimeFormatters,
  useDateTimeFormat,
} from "@/integration-api/runtime/useDateTimeFormat";
import { formatBytes } from "@/lib/storageFormat";

type DateInput = string | number | Date;

/**
 * Number, size, percentage, duration and date formatting for the admin area,
 * in the locale the reader chose rather than the browser's. Messages take the
 * formatted strings as arguments; counts go to ICU as numbers instead.
 */
export interface AdminFormatters {
  number: (value: number) => string;
  /** A byte count in binary units, such as "1.5 MB" or "1,5 MB". */
  bytes: (bytes: number) => string;
  /** A ratio from 0 to 1, such as "95%" or "95 %". */
  percent: (ratio: number) => string;
  /** Milliseconds, such as "850 ms", "1.5 s" or "2 min 5 s". */
  duration: (ms: number) => string;
  /**
   * Date and time per the reader's date and time format settings, in the
   * browser's time zone unless a zone is given (a request's own zone, say).
   */
  dateTime: (value: DateInput, options?: { timeZone?: string }) => string;
  /** `dateTime` for an optional server timestamp: "—" when it is missing or unreadable. */
  timestamp: (value: string | null | undefined) => string;
  date: (value: DateInput) => string;
  time: (value: DateInput) => string;
  /** The time with seconds, for log lines. */
  preciseTime: (value: DateInput) => string;
  /** The short weekday name, such as "Mon" or "Mo.". */
  weekday: (value: DateInput) => string;
  /** Wording relative to now, such as "5 minutes ago". */
  relative: (value: DateInput) => string;
}

export function adminFormatters(locale: string, dates: DateTimeFormatters): AdminFormatters {
  const integer = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const unit = (name: string, maximumFractionDigits = 0) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits,
    });
  const milliseconds = unit("millisecond");
  const seconds = unit("second", 1);
  const wholeSeconds = unit("second");
  const minutes = unit("minute");
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const preciseTime = new Intl.DateTimeFormat(locale, { timeStyle: "medium" });
  return {
    number: (value) => integer.format(value),
    bytes: (bytes) => formatBytes(bytes, locale),
    percent: (ratio) => percent.format(ratio),
    duration: (ms) => {
      if (ms < 1000) return milliseconds.format(Math.round(ms));
      if (ms < 60_000) return seconds.format(ms / 1000);
      return `${minutes.format(Math.floor(ms / 60_000))} ${wholeSeconds.format(
        Math.floor((ms % 60_000) / 1000),
      )}`;
    },
    dateTime: (value, options) => dates.dateTime(value, options),
    timestamp: (value) =>
      value && Number.isFinite(Date.parse(value)) ? dates.dateTime(value) : "—",
    date: (value) => dates.date(value),
    time: (value) => dates.time(value),
    preciseTime: (value) => preciseTime.format(new Date(value)),
    weekday: (value) => weekday.format(new Date(value)),
    relative: (value) => dates.relative(value),
  };
}

/** The admin formatters for the reader's chosen locale and date settings. */
export function useAdminFormat(): AdminFormatters {
  const locale = useLocale();
  const dates = useDateTimeFormat();
  return useMemo(() => adminFormatters(locale, dates), [locale, dates]);
}
