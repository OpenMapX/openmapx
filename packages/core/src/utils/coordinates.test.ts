import { describe, expect, it } from "vitest";
import { latLngOrNull } from "./coordinates.js";

describe("latLngOrNull", () => {
  it("accepts finite coordinates in range, including the bounds", () => {
    expect(latLngOrNull(52.5, 13.4)).toEqual({ lat: 52.5, lng: 13.4 });
    expect(latLngOrNull(-90, 180)).toEqual({ lat: -90, lng: 180 });
    expect(latLngOrNull(0, 0)).toEqual({ lat: 0, lng: 0 });
  });

  it("refuses values out of range, non-finite or not numbers", () => {
    expect(latLngOrNull(90.1, 0)).toBeNull();
    expect(latLngOrNull(0, -180.1)).toBeNull();
    expect(latLngOrNull(Number.NaN, 0)).toBeNull();
    expect(latLngOrNull(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(latLngOrNull("52.5", 13.4)).toBeNull();
    expect(latLngOrNull(undefined, null)).toBeNull();
  });
});
