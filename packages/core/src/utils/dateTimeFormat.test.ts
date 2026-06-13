import { describe, expect, it } from "vitest";
import { formatCalendarDate, formatClockTime, formatDateAndTime } from "./dateTimeFormat";

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
