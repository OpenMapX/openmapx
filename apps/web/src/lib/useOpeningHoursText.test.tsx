// @vitest-environment jsdom

import { useSettingsStore } from "@openmapx/core";
import { de, en } from "@openmapx/i18n";
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useOpeningHoursText } from "./useOpeningHoursText";

// The real catalogs and the real provider — the point of this hook is that the
// strings come from next-intl, so mocking it would test nothing.
const MESSAGES = { en, de } as const;

function wrapperFor(locale: "en" | "de") {
  return ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Berlin">
      {children}
    </NextIntlClientProvider>
  );
}

function textFor(locale: "en" | "de") {
  return renderHook(() => useOpeningHoursText(), { wrapper: wrapperFor(locale) }).result.current;
}

// 2026-07-22 is a Wednesday; weekday indices are 0 = Sunday.
const WEDNESDAY = 3;
const MONDAY = 1;

beforeEach(() => {
  useSettingsStore.setState({ timeFormat: "auto" });
});

describe("useOpeningHoursText — status detail", () => {
  it("renders an always-open place in the active locale", () => {
    const status = { isOpen: true };
    expect(textFor("en").detail(status)).toBe("Open 24 hours");
    expect(textFor("de").detail(status)).toBe("24 Stunden geöffnet");
  });

  it("renders the state word in the active locale", () => {
    expect(textFor("de").state({ isOpen: true })).toBe("Geöffnet");
    expect(textFor("de").state({ isOpen: false })).toBe("Geschlossen");
  });

  it("renders a same-day closing time", () => {
    const status = {
      isOpen: true,
      nextChange: { kind: "closes", at: "18:00", weekday: WEDNESDAY, day: "today" },
    } as const;
    // "auto" follows the locale's own convention: 12h for en, 24h for de.
    expect(textFor("en").detail(status)).toBe("Closes at 06:00 PM");
    expect(textFor("de").detail(status)).toBe("Schließt um 18:00");
  });

  it("renders tomorrow separately from a named weekday", () => {
    const tomorrow = {
      isOpen: false,
      nextChange: { kind: "opens", at: "06:30", weekday: WEDNESDAY, day: "tomorrow" },
    } as const;
    expect(textFor("en").detail(tomorrow)).toBe("Opens tomorrow at 06:30 AM");
    expect(textFor("de").detail(tomorrow)).toBe("Öffnet morgen um 06:30");

    const later = {
      isOpen: false,
      nextChange: { kind: "opens", at: "09:00", weekday: MONDAY, day: "other" },
    } as const;
    expect(textFor("en").detail(later)).toBe("Opens Mon at 09:00 AM");
    // German short weekday, from Intl rather than a translation key.
    expect(textFor("de").detail(later)).toBe("Öffnet Mo um 09:00");
  });

  it("shows the raw value verbatim when the hours can't be evaluated", () => {
    const status = { isOpen: false, isUnknown: true, text: "Mo-Su, PH 00:00-24:00" };
    expect(textFor("de").detail(status)).toBe("Mo-Su, PH 00:00-24:00");
  });

  it("appends the opening_hours comment", () => {
    const status = {
      isOpen: true,
      comment: "ring the bell",
      nextChange: { kind: "closes", at: "18:00", weekday: WEDNESDAY, day: "today" },
    } as const;
    expect(textFor("en").detail(status)).toBe("Closes at 06:00 PM (ring the bell)");
  });
});

describe("useOpeningHoursText — week schedule", () => {
  it("names weekdays in the active locale", () => {
    expect(textFor("en").weekday(WEDNESDAY)).toBe("Wednesday");
    expect(textFor("de").weekday(WEDNESDAY)).toBe("Mittwoch");
    expect(textFor("de").weekday(0)).toBe("Sonntag");
  });

  it("renders a closed day, an all-day span, and split spans", () => {
    const t = textFor("de");
    expect(t.dayHours({ weekday: 0, intervals: [], isToday: false })).toBe("Geschlossen");
    expect(
      t.dayHours({ weekday: 0, intervals: [{ from: "00:00", to: "24:00" }], isToday: false }),
    ).toBe("24 Stunden geöffnet");
    expect(
      t.dayHours({
        weekday: 0,
        intervals: [
          { from: "09:00", to: "12:00" },
          { from: "13:00", to: "17:00" },
        ],
        isToday: false,
      }),
    ).toBe("09:00–12:00, 13:00–17:00");
  });
});

describe("useOpeningHoursText — time format preference", () => {
  // German defaults to a 24h clock, so an explicit 12h preference has to
  // override the locale for this to prove anything.
  it("lets the Settings 12-hour preference override the locale default", () => {
    useSettingsStore.setState({ timeFormat: "12h" });
    const status = {
      isOpen: true,
      nextChange: { kind: "closes", at: "18:00", weekday: WEDNESDAY, day: "today" },
    } as const;
    expect(textFor("de").detail(status)).toBe("Schließt um 06:00 PM");
  });
});
