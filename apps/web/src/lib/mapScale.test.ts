import { describe, expect, it } from "vitest";
import { mapScale } from "./mapScale";

describe("mapScale", () => {
  it("rounds down to 1, 2, 3 or 5 times a power of ten and shortens the bar to match", () => {
    expect(mapScale(73, 64, "metric")).toEqual({ value: 50, unit: "m", width: 44 });
    expect(mapScale(260, 64, "metric")).toEqual({ value: 200, unit: "m", width: 49 });
    expect(mapScale(3.4, 64, "metric")).toEqual({ value: 3, unit: "m", width: 56 });
  });

  it("switches to kilometres once the span reaches one", () => {
    expect(mapScale(999, 64, "metric")?.unit).toBe("m");
    expect(mapScale(1250, 64, "metric")).toEqual({ value: 1, unit: "km", width: 51 });
  });

  it("uses feet, then miles, for imperial units", () => {
    expect(mapScale(100, 64, "imperial")).toEqual({ value: 300, unit: "ft", width: 59 });
    expect(mapScale(4000, 64, "imperial")).toEqual({ value: 2, unit: "mi", width: 51 });
  });

  it("has no scale for an empty or invalid span", () => {
    expect(mapScale(0, 64, "metric")).toBeNull();
    expect(mapScale(Number.NaN, 64, "metric")).toBeNull();
    expect(mapScale(100, 0, "metric")).toBeNull();
  });
});
