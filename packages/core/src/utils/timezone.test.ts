import { describe, expect, it } from "vitest";
import { localDateInZone, timeZoneAt, tzOffsetMinutes, zonedWallClockToInstant } from "./timezone";

describe("timeZoneAt", () => {
  it.each([
    ["Ciudad Juárez", 31.6904, -106.4245, "America/Ciudad_Juarez", "2026-11-21T12:00:00Z", -420],
    ["Coyhaique", -45.5752, -72.0662, "America/Coyhaique", "2026-07-15T12:00:00Z", -180],
  ] as const)(
    "uses the current zone and offset for %s",
    (_city, lat, lng, expected, at, offset) => {
      const zone = timeZoneAt(lat, lng);
      expect(zone).toBe(expected);
      expect(tzOffsetMinutes(new Date(at), zone ?? "")).toBe(offset);
    },
  );

  it("resolves ordinary coordinates in latitude, longitude order", () => {
    expect(timeZoneAt(52, 13)).toBe("Europe/Berlin");
    expect(timeZoneAt(49, -123)).toBe("America/Vancouver");
  });

  it("keeps Nuuk's renamed zone equivalent to its legacy alias", () => {
    const zone = timeZoneAt(64.1835, -51.7216);
    expect(zone).toBe("America/Nuuk");
    const at = new Date("2026-01-15T12:00:00Z");
    expect(tzOffsetMinutes(at, zone ?? "")).toBe(tzOffsetMinutes(at, "America/Godthab"));
  });

  it.each([
    [Number.NaN, 13],
    [52, Number.NaN],
    [Number.POSITIVE_INFINITY, 13],
    [52, Number.NEGATIVE_INFINITY],
    [91, 13],
    [-91, 13],
    [52, 181],
    [52, -181],
  ])("returns null for invalid coordinates (%s, %s)", (lat, lng) => {
    expect(timeZoneAt(lat, lng)).toBeNull();
  });
});

describe("zonedWallClockToInstant", () => {
  it("resolves ordinary DST and non-DST wall clocks", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-07-10T22:00")?.toISOString()).toBe(
      "2026-07-10T20:00:00.000Z",
    );
    expect(zonedWallClockToInstant("Asia/Kolkata", "2026-07-10T08:00")?.toISOString()).toBe(
      "2026-07-10T02:30:00.000Z",
    );
  });

  it("chooses the first valid instant after a spring-forward gap", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-03-29T02:30")?.toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });

  it("chooses the earlier instant for an ambiguous fall-back wall clock", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-10-25T02:30")?.toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("handles a DST transition that skips local midnight", () => {
    expect(zonedWallClockToInstant("America/Santiago", "2026-09-06T00:00")?.toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
  });

  it("rejects invalid dates, wall clocks, and zones", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-02-30T12:00")).toBeNull();
    expect(zonedWallClockToInstant("Europe/Berlin", "not-a-date")).toBeNull();
    expect(zonedWallClockToInstant("Mars/Olympus", "2026-01-01T00:00")).toBeNull();
  });
});

describe("localDateInZone", () => {
  it("returns the local calendar date", () => {
    expect(localDateInZone(new Date("2026-06-30T23:00:00Z"), "Europe/Berlin")).toBe("2026-07-01");
    expect(localDateInZone(new Date("2026-07-02T02:00:00Z"), "America/Vancouver")).toBe(
      "2026-07-01",
    );
  });
});
