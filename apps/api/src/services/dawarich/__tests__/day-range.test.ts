import { describe, expect, it } from "vitest";
import { computeDawarichDayRange } from "../day-range.js";

describe("computeDawarichDayRange", () => {
  it.each([
    {
      name: "a normal Berlin day",
      date: "2026-02-03",
      timeZone: "Europe/Berlin",
      startAt: "2026-02-02T23:00:00Z",
      endAt: "2026-02-03T22:59:59.999999999Z",
      durationSeconds: 86_400,
    },
    {
      name: "the Berlin spring DST transition",
      date: "2026-03-29",
      timeZone: "Europe/Berlin",
      startAt: "2026-03-28T23:00:00Z",
      endAt: "2026-03-29T21:59:59.999999999Z",
      durationSeconds: 82_800,
    },
    {
      name: "the Berlin autumn DST transition",
      date: "2026-10-25",
      timeZone: "Europe/Berlin",
      startAt: "2026-10-24T22:00:00Z",
      endAt: "2026-10-25T22:59:59.999999999Z",
      durationSeconds: 90_000,
    },
    {
      name: "a UTC leap day",
      date: "2024-02-29",
      timeZone: "UTC",
      startAt: "2024-02-29T00:00:00Z",
      endAt: "2024-02-29T23:59:59.999999999Z",
      durationSeconds: 86_400,
    },
  ])("returns exact inclusive instants for $name", (testCase) => {
    expect(computeDawarichDayRange(testCase.date, testCase.timeZone)).toEqual({
      startAt: testCase.startAt,
      endAt: testCase.endAt,
      durationSeconds: testCase.durationSeconds,
    });
  });

  it.each(["2026-3-09", "2026-02-30", "2026-01-01T00:00:00Z"])(
    "rejects malformed or impossible calendar date %s",
    (date) => {
      expect(() => computeDawarichDayRange(date, "UTC")).toThrow("Invalid calendar date");
    },
  );

  it("rejects a calendar date that does not exist in the requested zone", () => {
    expect(() => computeDawarichDayRange("2011-12-30", "Pacific/Apia")).toThrow(
      "Invalid calendar date",
    );
  });

  it("rejects invalid IANA time zones", () => {
    expect(() => computeDawarichDayRange("2026-08-09", "Mars/Olympus")).toThrow(
      "Invalid time zone",
    );
  });
});
