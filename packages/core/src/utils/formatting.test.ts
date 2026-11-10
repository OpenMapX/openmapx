import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatMeasurementDistance,
  formatOverviewDistance,
  measurementDistanceParts,
} from "./formatting";

describe("formatMeasurementDistance (metric km)", () => {
  it("shows one decimal for a single-digit kilometre value", () => {
    expect(formatMeasurementDistance(1160)).toBe("1.2 km");
    expect(formatMeasurementDistance(5300)).toBe("5.3 km");
    expect(formatMeasurementDistance(1000)).toBe("1.0 km");
  });

  it("drops decimals once the value reaches double digits", () => {
    expect(formatMeasurementDistance(10_000)).toBe("10 km");
    expect(formatMeasurementDistance(10_040)).toBe("10 km");
    expect(formatMeasurementDistance(23_500)).toBe("24 km");
    expect(formatMeasurementDistance(100_000)).toBe("100 km");
  });

  it("drops decimals at the boundary where one-decimal rounding reaches 10", () => {
    expect(formatMeasurementDistance(9960)).toBe("10 km");
    expect(formatMeasurementDistance(9940)).toBe("9.9 km");
  });

  it("still shows metres below a kilometre", () => {
    expect(formatMeasurementDistance(850)).toBe("850 m");
  });
});

describe("measurementDistanceParts", () => {
  it("gives renderers the banner's rounding as number and unit", () => {
    expect(measurementDistanceParts(614.8)).toEqual({ value: 615, unit: "m", decimals: 0 });
    expect(measurementDistanceParts(3312)).toEqual({ value: 3.3, unit: "km", decimals: 1 });
    expect(measurementDistanceParts(23400)).toEqual({ value: 23, unit: "km", decimals: 0 });
    expect(measurementDistanceParts(300, "imperial")).toEqual({
      value: 984,
      unit: "ft",
      decimals: 0,
    });
    expect(measurementDistanceParts(2000, "imperial")).toEqual({
      value: 1.24,
      unit: "mi",
      decimals: 2,
    });
    expect(measurementDistanceParts(Number.NaN)).toEqual({ value: 0, unit: "m", decimals: 0 });
  });
});

describe("formatOverviewDistance", () => {
  it.each([
    [0, "0 m"],
    [850, "850 m"],
    [5300, "5.3 km"],
    [9960, "10 km"],
    [12_000, "12 km"],
    [400_000, "400 km"],
  ])("rounds %d m as %s in metric", (metres, text) => {
    expect(formatOverviewDistance(metres, "metric")).toBe(text);
    expect(formatOverviewDistance(metres)).toBe(text);
  });

  it.each([
    [0, "0 ft"],
    [100, "328 ft"],
    [1500, "4921 ft"],
    [1609.34, "1.0 mi"],
    [8500, "5.3 mi"],
    [16_000, "9.9 mi"],
    [16_093, "10 mi"],
    [16_100, "10 mi"],
    [400_000, "249 mi"],
    [1_000_000, "621 mi"],
  ])("rounds %d m as %s in imperial, whole from 10 up like metric", (metres, text) => {
    expect(formatOverviewDistance(metres, "imperial")).toBe(text);
  });

  it("leaves guidance precision to the step formatter", () => {
    expect(formatMeasurementDistance(400_000, "imperial")).toBe("248.55 mi");
  });

  it("treats a negative or non-finite distance as zero", () => {
    expect(formatOverviewDistance(-5, "imperial")).toBe("0 ft");
    expect(formatOverviewDistance(Number.NaN, "imperial")).toBe("0 ft");
  });
});

describe("formatDuration", () => {
  it.each([
    [45, "en", "45 sec"],
    [45, "de", "45 Sek."],
    [720, "en", "12 min"],
    [720, "de", "12 Min."],
    [3600, "en", "1 hr"],
    [3600, "de", "1 Std."],
    [4980, "en", "1 hr 23 min"],
    [4980, "de", "1 Std. 23 Min."],
  ])("writes %d s in %s as %s", (seconds, locale, text) => {
    expect(formatDuration(seconds, locale)).toBe(text);
  });

  it("carries no English unit into German", () => {
    for (const seconds of [5, 59, 60, 3599, 3600, 5400, 90_000]) {
      expect(formatDuration(seconds, "de")).not.toMatch(/\b(sec|hr|h)\b/);
    }
  });

  it("rounds to the nearest minute from a minute up", () => {
    expect(formatDuration(89, "en")).toBe("1 min");
    expect(formatDuration(90, "en")).toBe("2 min");
  });
});
