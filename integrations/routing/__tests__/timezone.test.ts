import { describe, expect, it } from "vitest";
import { localDateInZone, zonedWallClockToInstant } from "../timezone";

describe("zonedWallClockToInstant", () => {
  it("resolves a summer (CEST, +02:00) Berlin wall-clock to UTC", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-07-10T22:00")?.toISOString()).toBe(
      "2026-07-10T20:00:00.000Z",
    );
  });
  it("resolves a winter (CET, +01:00) Berlin wall-clock to UTC (DST-aware)", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "2026-01-10T22:00")?.toISOString()).toBe(
      "2026-01-10T21:00:00.000Z",
    );
  });
  it("resolves a Pacific (PDT, -07:00) wall-clock to UTC", () => {
    expect(zonedWallClockToInstant("America/Vancouver", "2026-07-10T08:00")?.toISOString()).toBe(
      "2026-07-10T15:00:00.000Z",
    );
  });
  it("returns null for an unparseable wall-clock", () => {
    expect(zonedWallClockToInstant("Europe/Berlin", "not-a-date")).toBeNull();
  });
});

describe("localDateInZone", () => {
  it("rolls to the next local date past midnight", () => {
    // 23:00Z = 01:00 the next day in Berlin (CEST).
    expect(localDateInZone(new Date("2026-06-30T23:00:00Z"), "Europe/Berlin")).toBe("2026-07-01");
  });
  it("stays on the same local date during the day", () => {
    expect(localDateInZone(new Date("2026-06-30T14:00:00Z"), "Europe/Berlin")).toBe("2026-06-30");
  });
  it("rolls back a day for a western zone", () => {
    // 02:00Z = 19:00 the previous day in Vancouver (PDT).
    expect(localDateInZone(new Date("2026-07-02T02:00:00Z"), "America/Vancouver")).toBe(
      "2026-07-01",
    );
  });
});
