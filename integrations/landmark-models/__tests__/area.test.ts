import { describe, expect, it } from "vitest";
import { areaOfInterest, cellsInArea } from "../web/area";

const METRES_PER_DEGREE_LAT = 111_320;

describe("areaOfInterest", () => {
  it("pads a small viewport by 25%", () => {
    const area = areaOfInterest({ center: [2.29, 48.86], bounds: [2.28, 48.85, 2.3, 48.87] });
    expect(area[0]).toBeCloseTo(2.275, 6);
    expect(area[2]).toBeCloseTo(2.305, 6);
    expect(area[1]).toBeCloseTo(48.845, 6);
    expect(area[3]).toBeCloseTo(48.875, 6);
  });

  it("cuts the padded viewport at 3 km from the centre", () => {
    // A pitched camera can see to the horizon.
    const area = areaOfInterest({ center: [2.29, 48.86], bounds: [1.5, 48.2, 3.1, 49.9] });
    const halfHeightM = ((area[3] - area[1]) / 2) * METRES_PER_DEGREE_LAT;
    const halfWidthM =
      ((area[2] - area[0]) / 2) * METRES_PER_DEGREE_LAT * Math.cos((48.86 * Math.PI) / 180);
    expect(halfHeightM).toBeLessThanOrEqual(3_000.5);
    expect(halfWidthM).toBeLessThanOrEqual(3_000.5);
    expect(halfHeightM).toBeGreaterThan(2_999);
  });
});

describe("cellsInArea", () => {
  it("returns only occupied cells", () => {
    const area: [number, number, number, number] = [2.28, 48.85, 2.31, 48.87];
    expect(cellsInArea(area, new Set(["2074/1409", "9/9"]))).toEqual(["2074/1409"]);
    expect(cellsInArea(area, new Set())).toEqual([]);
  });
});
