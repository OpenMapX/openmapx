import { describe, expect, it } from "vitest";
import {
  formatCalendarDate,
  formatClockTime,
  formatDateAndTime,
  formatRecentOrDateTime,
  formatRelativeTime,
} from "./dateTimeFormat";

// Fixed instant: 2025-01-31 13:05 UTC. Tests pin timeZone: "UTC" so they are
// stable regardless of the machine's local zone.
const ISO = "2025-01-31T13:05:00Z";

describe("formatClockTime", () => {
  it("renders 24-hour time when timeFormat is 24h", () => {
    expect(formatClockTime(ISO, { locale: "en-US", timeFormat: "24h", timeZone: "UTC" })).toBe(
      "13:05",
    );
  });

  it("renders 12-hour time when timeFormat is 12h", () => {
    expect(formatClockTime(ISO, { locale: "en-US", timeFormat: "12h", timeZone: "UTC" })).toBe(
      "01:05 PM",
    );
  });

  it("follows the locale convention when timeFormat is auto", () => {
    expect(formatClockTime(ISO, { locale: "de-DE", timeFormat: "auto", timeZone: "UTC" })).toBe(
      "13:05",
    );
    expect(formatClockTime(ISO, { locale: "en-US", timeFormat: "auto", timeZone: "UTC" })).toBe(
      "01:05 PM",
    );
  });

  it("returns an empty string for invalid input", () => {
    expect(formatClockTime("not-a-date")).toBe("");
    expect(formatClockTime("")).toBe("");
  });
});

describe("formatCalendarDate", () => {
  it("renders dotted day-month-year for dmy", () => {
    expect(formatCalendarDate(ISO, { dateFormat: "dmy", timeZone: "UTC" })).toBe("31.01.2025");
  });

  it("renders slashed month-day-year for mdy", () => {
    expect(formatCalendarDate(ISO, { dateFormat: "mdy", timeZone: "UTC" })).toBe("01/31/2025");
  });

  it("renders dashed ISO year-month-day for ymd", () => {
    expect(formatCalendarDate(ISO, { dateFormat: "ymd", timeZone: "UTC" })).toBe("2025-01-31");
  });

  it("follows the locale convention when dateFormat is auto", () => {
    expect(formatCalendarDate(ISO, { locale: "de-DE", dateFormat: "auto", timeZone: "UTC" })).toBe(
      "31.01.2025",
    );
    expect(formatCalendarDate(ISO, { locale: "en-US", dateFormat: "auto", timeZone: "UTC" })).toBe(
      "01/31/2025",
    );
  });

  it("returns an empty string for invalid input", () => {
    expect(formatCalendarDate("not-a-date")).toBe("");
  });
});

describe("formatDateAndTime", () => {
  it("combines date and time per preference", () => {
    expect(
      formatDateAndTime(ISO, {
        locale: "en-US",
        dateFormat: "ymd",
        timeFormat: "24h",
        timeZone: "UTC",
      }),
    ).toBe("2025-01-31, 13:05");
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.parse(ISO);
  const ago = (seconds: number) => NOW - seconds * 1000;

  it("words the age in the viewer's language, with no English fragments in German", () => {
    const german = [
      formatRelativeTime(ago(30), { locale: "de", now: NOW }),
      formatRelativeTime(ago(5 * 60), { locale: "de", now: NOW }),
      formatRelativeTime(ago(3 * 3600), { locale: "de", now: NOW }),
      formatRelativeTime(ago(2 * 86400), { locale: "de", now: NOW }),
      formatRelativeTime(ago(90 * 86400), { locale: "de", now: NOW }),
      formatRelativeTime(ago(800 * 86400), { locale: "de", now: NOW }),
    ];
    expect(german).toEqual([
      "vor 30 Sekunden",
      "vor 5 Minuten",
      "vor 3 Stunden",
      "vorgestern",
      "vor 3 Monaten",
      "vor 2 Jahren",
    ]);
    for (const text of german) expect(text).not.toMatch(/\bago\b|\d[smhd]\b/);
  });

  it("uses the largest whole unit in English", () => {
    expect(formatRelativeTime(ago(5 * 60), { locale: "en", now: NOW })).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(2 * 86400), { locale: "en", now: NOW })).toBe("2 days ago");
    expect(formatRelativeTime(ago(400 * 86400), { locale: "en", now: NOW })).toBe("last year");
  });

  it("is empty for an unreadable timestamp", () => {
    expect(formatRelativeTime("not a date", { locale: "en", now: NOW })).toBe("");
  });
});

describe("formatRelativeTime clock skew", () => {
  const NOW = Date.parse(ISO);

  it("reads a moment under a minute ahead as now", () => {
    expect(formatRelativeTime(NOW + 5_000, { locale: "en", now: NOW })).toBe("now");
    expect(formatRelativeTime(NOW + 59_000, { locale: "de", now: NOW })).toBe("jetzt");
  });

  it("keeps real future times and past seconds as they were", () => {
    expect(formatRelativeTime(NOW + 5 * 60_000, { locale: "en", now: NOW })).toBe("in 5 minutes");
    expect(formatRelativeTime(NOW - 5_000, { locale: "en", now: NOW })).toBe("5 seconds ago");
  });
});

describe("formatRecentOrDateTime", () => {
  const NOW = Date.parse(ISO);
  const base = {
    locale: "en-US",
    dateFormat: "ymd",
    timeFormat: "24h",
    timeZone: "UTC",
    now: NOW,
  } as const;
  const hoursAgo = (hours: number) => NOW - hours * 3_600_000;

  it("words anything within the last day relatively", () => {
    expect(formatRecentOrDateTime(hoursAgo(3), base)).toBe("3 hours ago");
    expect(formatRecentOrDateTime(hoursAgo(23.9), base)).toBe("24 hours ago");
  });

  it("gives the date and time per preference from a day on", () => {
    expect(formatRecentOrDateTime(hoursAgo(24), base)).toBe("2025-01-30, 13:05");
    expect(formatRecentOrDateTime(hoursAgo(24 * 90), base)).toBe("2024-11-02, 13:05");
    expect(formatRecentOrDateTime(hoursAgo(24), { ...base, timeFormat: "12h" })).toBe(
      "2025-01-30, 01:05 PM",
    );
  });

  it("localizes the relative side", () => {
    expect(formatRecentOrDateTime(hoursAgo(3), { ...base, locale: "de" })).toBe("vor 3 Stunden");
  });

  it("is empty for an unreadable timestamp", () => {
    expect(formatRecentOrDateTime("nope", base)).toBe("");
  });
});
