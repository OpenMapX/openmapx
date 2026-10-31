import { describe, expect, it } from "vitest";
import { forecastTimeZone, groupByLocalDay } from "./lib.js";

const HOUR_MS = 60 * 60 * 1000;

function hourlyInstants(firstIso: string, count: number): string[] {
  const first = Date.parse(firstIso);
  return Array.from({ length: count }, (_, i) => new Date(first + i * HOUR_MS).toISOString());
}

describe("forecastTimeZone", () => {
  it("resolves the IANA zone of a coordinate", () => {
    expect(forecastTimeZone([174.7633, -36.8485])).toBe("Pacific/Auckland");
    expect(forecastTimeZone([-74.006, 40.7128])).toBe("America/New_York");
  });

  it("states UTC for a coordinate without a resolvable zone", () => {
    expect(forecastTimeZone([0, 95])).toBe("UTC");
  });
});

describe("groupByLocalDay", () => {
  it("groups UTC instants by the calendar date in the location's zone", () => {
    // Auckland is UTC+13 in November: its 1 November runs 10-31T11:00Z..11-01T10:00Z.
    const instants = hourlyInstants("2026-10-31T10:00:00Z", 26);
    const days = groupByLocalDay(instants, (t) => t, "Pacific/Auckland");

    expect(days.map((d) => [d.date, d.records.length])).toEqual([
      ["2026-10-31", 1],
      ["2026-11-01", 24],
      ["2026-11-02", 1],
    ]);
    expect(days[1]?.records[0]).toBe("2026-10-31T11:00:00.000Z");
    expect(days[1]?.records.at(-1)).toBe("2026-11-01T10:00:00.000Z");
    // Local noon on 1 November is 23:00 UTC the day before.
    expect(days[1]?.noon).toBe("2026-10-31T23:00:00.000Z");
  });

  it("keeps all 25 hours of a day on which daylight saving time ends", () => {
    // New York leaves EDT (UTC-4) for EST (UTC-5) at 02:00 local on 1 November 2026.
    const instants = hourlyInstants("2026-11-01T04:00:00Z", 26);
    const days = groupByLocalDay(instants, (t) => t, "America/New_York");

    expect(days.map((d) => [d.date, d.records.length])).toEqual([
      ["2026-11-01", 25],
      ["2026-11-02", 1],
    ]);
    // 12:00 EST.
    expect(days[0]?.noon).toBe("2026-11-01T17:00:00.000Z");
  });

  it("reads offset timestamps as the instants they state", () => {
    const days = groupByLocalDay(
      ["2026-11-01T23:00:00-05:00", "2026-11-02T00:00:00-05:00"],
      (t) => t,
      "America/New_York",
    );
    expect(days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("takes the later record when two are equally near local noon", () => {
    const days = groupByLocalDay(
      ["2026-03-10T10:00:00Z", "2026-03-10T12:00:00Z"],
      (t) => t,
      "Europe/Berlin",
    );
    expect(days[0]?.noon).toBe("2026-03-10T12:00:00Z");
  });

  it("skips records whose time cannot be read", () => {
    const days = groupByLocalDay(["not a time", "2026-03-10T12:00:00Z"], (t) => t, "UTC");
    expect(days).toEqual([
      { date: "2026-03-10", records: ["2026-03-10T12:00:00Z"], noon: "2026-03-10T12:00:00Z" },
    ]);
  });
});
