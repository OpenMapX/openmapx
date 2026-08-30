import { describe, expect, it } from "vitest";
import { normalizeSamples } from "../normalize/samples";
import { buildWindow, localDayWindow } from "../normalize/windows";

function sample(start: string, end: string, value = 10, valid = true, gapFilled = false) {
  return {
    startAt: start,
    endAt: end,
    value,
    unit: "ug/m3" as const,
    valid,
    estimated: false,
    gapFilled,
  };
}

describe("pollutant windows", () => {
  it("uses half-open windows, counts valid samples, and retains invalid samples", () => {
    const samples = normalizeSamples(
      [
        sample("2026-08-29T23:00:00Z", "2026-08-30T00:00:00Z"),
        sample("2026-08-30T00:00:00Z", "2026-08-30T01:00:00Z"),
        sample("2026-08-30T01:00:00Z", "2026-08-30T02:00:00Z", -1),
        sample("2026-08-30T02:00:00Z", "2026-08-30T03:00:00Z", 20, true, true),
        sample("2026-08-30T03:00:00Z", "2026-08-30T04:00:00Z"),
      ],
      "ug/m3",
    );
    const window = buildWindow("pm25", samples, {
      startAt: "2026-08-30T00:00:00Z",
      endAt: "2026-08-30T03:00:00Z",
      expectedCadenceMinutes: 60,
      minimumCompletenessPercent: 75,
    });
    expect(window).toMatchObject({
      sampleCount: 2,
      expectedSampleCount: 3,
      complete: false,
      gapFilled: true,
    });
    expect(window.completenessPercent).toBeCloseTo(200 / 3);
    expect(window.invalidSamples).toHaveLength(1);
  });

  it("resolves civil days across DST rather than assuming 24 hours", () => {
    const shortDay = localDayWindow("2026-03-29", "Europe/Berlin");
    const longDay = localDayWindow("2026-10-25", "Europe/Berlin");
    expect(Date.parse(shortDay.endAt) - Date.parse(shortDay.startAt)).toBe(23 * 3_600_000);
    expect(Date.parse(longDay.endAt) - Date.parse(longDay.startAt)).toBe(25 * 3_600_000);
    expect(() => localDayWindow("2026-02-30", "UTC")).toThrow(/valid civil date/);
  });

  it("counts unique cadence-aligned intervals instead of raw records", () => {
    const samples = normalizeSamples(
      [
        sample("2026-08-30T00:00:00Z", "2026-08-30T01:00:00Z", 10),
        sample("2026-08-30T00:00:00Z", "2026-08-30T01:00:00Z", 10),
        sample("2026-08-30T01:15:00Z", "2026-08-30T02:15:00Z", 20),
        sample("2026-08-30T02:00:00Z", "2026-08-30T02:30:00Z", 30),
      ],
      "ug/m3",
    );

    const window = buildWindow("pm25", samples, {
      startAt: "2026-08-30T00:00:00Z",
      endAt: "2026-08-30T03:00:00Z",
      expectedCadenceMinutes: 60,
      minimumCompletenessPercent: 50,
    });

    expect(window).toMatchObject({
      sampleCount: 1,
      expectedSampleCount: 3,
      complete: false,
    });
    expect(window.completenessPercent).toBeCloseTo(100 / 3);
    expect(window.invalidSamples).toHaveLength(2);
  });
});
