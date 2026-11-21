import { EARTH_CIRCUMFERENCE_M as CORE_CIRCUMFERENCE } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { EARTH_CIRCUMFERENCE_M, metresPerUnit, tileCentreLat } from "../web/derive/units";

/** The z16 tile row containing a latitude. */
function rowAt(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z);
}

describe("units", () => {
  it("uses the same Earth circumference as the core frame maths", () => {
    expect(EARTH_CIRCUMFERENCE_M).toBe(CORE_CIRCUMFERENCE);
  });

  it("finds the latitude of a tile centre", () => {
    expect(tileCentreLat(0, 0)).toBeCloseTo(0, 9);
    expect(tileCentreLat(1, 0)).toBeCloseTo(66.513, 3);
    const y = rowAt(52.5, 16);
    expect(Math.abs(tileCentreLat(16, y) - 52.5)).toBeLessThan(0.005);
  });

  it("measures one tile unit in metres", () => {
    expect(metresPerUnit(16, rowAt(52.5, 16), 4096)).toBeCloseTo(0.09078, 4);
    expect(metresPerUnit(17, rowAt(52.5, 17), 4096)).toBeCloseTo(0.09078 / 2, 4);
  });
});
