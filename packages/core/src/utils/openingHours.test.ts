import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpeningHoursInfo, isAlwaysOpen, parseOpeningHours } from "./openingHours";

// Berlin (CEST = UTC+2 in May). The schedule is evaluated against the place's
// local wall-clock, not the server's (which is UTC in production).
const BERLIN = { lat: 52.516, lon: 13.388, countryCode: "de" };
const HOURS = "Mo-Su 06:30-23:00";

describe("parseOpeningHours — place-local timezone", () => {
  afterEach(() => vi.useRealTimers());

  it("is closed at 01:30 place-local even when the server clock reads 23:30 UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T23:30:00Z")); // 01:30 in Berlin
    const status = parseOpeningHours(HOURS, BERLIN);
    expect(status?.isOpen).toBe(false);
    expect(status?.nextChange).toMatchObject({ kind: "opens", at: "06:30", day: "today" });
  });

  it("is open at 12:00 place-local", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00Z")); // 12:00 in Berlin
    const status = parseOpeningHours(HOURS, BERLIN);
    expect(status?.isOpen).toBe(true);
    expect(status?.nextChange).toMatchObject({ kind: "closes", at: "23:00", day: "today" });
  });

  it("uses the place timezone, not the server's — a Tokyo place at the same instant", () => {
    // 23:30 UTC = 08:30 next day in Tokyo (JST, UTC+9) — open.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T23:30:00Z"));
    const tokyo = { lat: 35.68, lon: 139.76, countryCode: "jp" };
    const status = parseOpeningHours(HOURS, tokyo);
    expect(status?.isOpen).toBe(true);
  });
});

describe("parseOpeningHours — status is data, not prose", () => {
  afterEach(() => vi.useRealTimers());

  it("dates the next change so the client can say today/tomorrow/weekday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T21:00:00Z")); // Thursday 23:00 in Berlin
    const status = parseOpeningHours("Mo-Su 06:30-23:00", BERLIN);
    // Just closed for the night; reopens Friday morning.
    expect(status?.isOpen).toBe(false);
    expect(status?.nextChange).toEqual({
      kind: "opens",
      at: "06:30",
      weekday: 5, // Friday
      day: "tomorrow",
    });
  });

  it("names the weekday when the change is further out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T10:00:00Z")); // Saturday in Berlin
    const status = parseOpeningHours("Mo-Fr 09:00-17:00", BERLIN);
    expect(status?.isOpen).toBe(false);
    expect(status?.nextChange).toEqual({
      kind: "opens",
      at: "09:00",
      weekday: 1, // Monday
      day: "other",
    });
  });

  it("emits the week schedule as weekday index + intervals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00Z")); // Thursday in Berlin
    const status = parseOpeningHours("Mo-Fr 09:00-12:00,13:00-17:00; Sa,Su off", BERLIN);
    expect(status?.weekSchedule?.[0]).toEqual({
      weekday: 4, // Thursday, today
      intervals: [
        { from: "09:00", to: "12:00" },
        { from: "13:00", to: "17:00" },
      ],
      isToday: true,
    });
    // Saturday is closed -> no intervals at all, not the word "Closed".
    expect(status?.weekSchedule?.[2]).toEqual({ weekday: 6, intervals: [], isToday: false });
  });
});

// Aachen, North Rhine-Westphalia. A `PH` selector makes the library resolve
// German public holidays, which needs the country code from the location.
const AACHEN = { lat: 50.775, lon: 6.084, countryCode: "de", state: "Nordrhein-Westfalen" };

describe("parseOpeningHours — always-open rules with a public-holiday selector", () => {
  afterEach(() => vi.useRealTimers());

  // `getNextChange` has no natural stopping point when the state never changes
  // but the rule still has yearly PH boundaries, so it must be given a bound.
  it("reports a 24/7 charging station as open, not closed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00Z"));
    const status = parseOpeningHours("Mo-Su, PH 00:00-24:00", AACHEN);
    expect(status?.isOpen).toBe(true);
    // No upcoming change + open = always open; the client renders "Open 24 hours".
    expect(status?.nextChange).toBeUndefined();
    expect(status?.weekSchedule?.[0]?.intervals).toEqual([{ from: "00:00", to: "24:00" }]);
  });

  it("treats it as always open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00Z"));
    expect(isAlwaysOpen("Mo-Su, PH 00:00-24:00", AACHEN)).toBe(true);
    expect(buildOpeningHoursInfo("Mo-Su, PH 00:00-24:00", AACHEN)?.isAlwaysOpen).toBe(true);
  });

  it("still finds the next change for a rule that does close on holidays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00Z")); // Wednesday, 12:00 in Aachen
    const status = parseOpeningHours("Mo-Fr 08:00-18:00; PH off", AACHEN);
    expect(status?.isOpen).toBe(true);
    expect(status?.nextChange).toMatchObject({ kind: "closes", at: "18:00", day: "today" });
  });
}, 10_000);

describe("parseOpeningHours — unevaluable values", () => {
  // A `PH` rule without a country code cannot be resolved at all. Reporting
  // that as a definite "Closed" is worse than admitting we don't know.
  it("does not claim a place is closed when the value cannot be evaluated", () => {
    const status = parseOpeningHours("Mo-Su, PH 00:00-24:00", { lat: 50.775, lon: 6.084 });
    expect(status?.isOpen).toBe(false);
    expect(status?.isUnknown).toBe(true);
    expect(status?.text).toBe("Mo-Su, PH 00:00-24:00");
  });

  it("surfaces the comment for ambiguous hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00Z")); // Thursday 12:00 in Berlin
    const status = parseOpeningHours('Mo-Fr 09:00-17:00 unknown "by appointment"', BERLIN);
    expect(status?.isUnknown).toBe(true);
    expect(status?.text).toBe("by appointment");
    vi.useRealTimers();
  });
});
