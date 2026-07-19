import { describe, expect, it } from "vitest";
import { formatMeasurementDistance } from "./formatting";

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
