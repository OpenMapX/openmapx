import { describe, expect, it } from "vitest";
import { interpolateAlong } from "../vehicle-radar.js";

describe("interpolateAlong", () => {
  it("returns the endpoints at fraction 0 and 1", () => {
    const coords: [number, number][] = [
      [0, 0],
      [0, 1],
    ];
    expect(interpolateAlong(coords, 0)).toMatchObject({ lng: 0, lat: 0 });
    expect(interpolateAlong(coords, 1)).toMatchObject({ lng: 0, lat: 1 });
  });

  it("interpolates the midpoint of a single segment", () => {
    const mid = interpolateAlong(
      [
        [0, 0],
        [0, 1],
      ],
      0.5,
    );
    expect(mid.lat).toBeCloseTo(0.5, 6);
    expect(mid.lng).toBeCloseTo(0, 6);
  });

  it("reports a northward bearing of ~0° and eastward of ~90°", () => {
    const north = interpolateAlong(
      [
        [0, 0],
        [0, 1],
      ],
      0.5,
    );
    expect(north.bearing).toBeCloseTo(0, 3);
    const east = interpolateAlong(
      [
        [0, 0],
        [1, 0],
      ],
      0.5,
    );
    expect(east.bearing).toBeCloseTo(90, 3);
  });

  it("clamps out-of-range fractions and handles degenerate input", () => {
    const coords: [number, number][] = [
      [2, 3],
      [2, 3],
    ];
    expect(interpolateAlong(coords, 0.5)).toMatchObject({ lng: 2, lat: 3, bearing: 0 });
    expect(interpolateAlong([[5, 6]], 0.5)).toMatchObject({ lng: 5, lat: 6 });
    expect(interpolateAlong([], 0.5)).toMatchObject({ lng: 0, lat: 0 });
  });
});
