import { describe, expect, it } from "vitest";
import { localDateInZone, zonedWallClockToInstant } from "./timezone";

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
