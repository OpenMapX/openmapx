import { describe, expect, it } from "vitest";
import { AVERAGE_CAR_CO2_GRAMS_PER_KM, estimateDrivingCo2Grams } from "./co2";

describe("estimateDrivingCo2Grams", () => {
  it("scales linearly with distance using the average-car factor", () => {
    expect(estimateDrivingCo2Grams(1000)).toBe(AVERAGE_CAR_CO2_GRAMS_PER_KM);
    expect(estimateDrivingCo2Grams(10_000)).toBe(AVERAGE_CAR_CO2_GRAMS_PER_KM * 10);
  });

  it("returns 0 for non-positive or non-finite input", () => {
    expect(estimateDrivingCo2Grams(0)).toBe(0);
    expect(estimateDrivingCo2Grams(-5)).toBe(0);
    expect(estimateDrivingCo2Grams(Number.NaN)).toBe(0);
  });
});
