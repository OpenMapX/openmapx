"use client";

import type { DaySchedule, OpeningHoursStatus } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

export interface OpeningHoursText {
  /** Translated "Open" / "Closed" for the coloured state word. */
  state: (status: OpeningHoursStatus) => string;
  /** e.g. "Closes at 17:00", "Opens Mon at 09:00", "Open 24 hours". */
  detail: (status: OpeningHoursStatus) => string;
  /** Localized weekday name for the expanded schedule, e.g. "Mittwoch". */
  weekday: (weekday: number) => string;
  /** One day's hours, e.g. "09:00–17:00", "Open 24 hours", "Closed". */
  dayHours: (day: DaySchedule) => string;
}

/**
 * A Date carrying `hh:mm` as its *local* fields, so `formatClockTime` renders
 * exactly that wall-clock in the user's 12h/24h preference. The calendar day is
 * irrelevant — only hour and minute are formatted.
 */
function wallClock(hhmm: string): Date {
  const [h, m] = hhmm.split(":");
  const d = new Date(2000, 0, 1);
  // "24:00" means end-of-day; roll it to 00:00 so Intl renders it as midnight.
  d.setHours(Number(h) % 24, Number(m), 0, 0);
  return d;
}

/**
 * Turns the server's structured `OpeningHoursStatus` into display text.
 *
 * The API deliberately ships data (weekday indices, "HH:MM" wall-clock spans,
 * an opens/closes descriptor) rather than sentences, so everything the user
 * reads is built here: translated through next-intl and formatted through the
 * Settings time-format preference. Both the place panel and the category list
 * go through this hook so they can't drift apart.
 */
export function useOpeningHoursText(): OpeningHoursText {
  const t = useTranslations("openingHours");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { time } = useDateTimeFormat();

  return useMemo<OpeningHoursText>(() => {
    // 2024-01-07 is a Sunday, so adding the weekday index lands on that day.
    const nameFor = (style: "long" | "short") => (weekday: number) =>
      new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(
        new Date(Date.UTC(2024, 0, 7 + weekday)),
      );
    const longName = nameFor("long");
    const shortName = nameFor("short");
    const at = (hhmm: string) => time(wallClock(hhmm));

    // Spelled out rather than built from `${kind}${day}At` so the translation
    // checker can see every key statically.
    const changeText = (status: OpeningHoursStatus) => {
      const next = status.nextChange;
      // Nothing ahead within a year: open forever, or closed forever.
      if (!next) return status.isOpen ? t("open24Hours") : tc("closed");
      const values = { time: at(next.at), day: shortName(next.weekday) };
      if (next.kind === "closes") {
        if (next.day === "today") return t("closesAt", values);
        if (next.day === "tomorrow") return t("closesTomorrowAt", values);
        return t("closesOnAt", values);
      }
      if (next.day === "today") return t("opensAt", values);
      if (next.day === "tomorrow") return t("opensTomorrowAt", values);
      return t("opensOnAt", values);
    };

    const detail = (status: OpeningHoursStatus) => {
      if (status.isUnknown) return status.text ?? "";
      const text = changeText(status);
      return status.comment ? `${text} (${status.comment})` : text;
    };

    return {
      state: (status) => (status.isOpen ? tc("open") : tc("closed")),
      detail,
      weekday: longName,
      dayHours: (day) => {
        if (day.intervals.length === 0) return tc("closed");
        const allDay = day.intervals.some((i) => i.from === "00:00" && i.to === "24:00");
        if (allDay) return t("open24Hours");
        return day.intervals.map((i) => `${at(i.from)}–${at(i.to)}`).join(", ");
      },
    };
  }, [t, tc, locale, time]);
}
