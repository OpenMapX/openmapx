import { MercatorCoordinate } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  cameraMatrix,
  EARTH_CIRCUMFERENCE_M,
  instanceMatrix,
  mercatorOrigin,
  multiply4,
  objectMatrix,
  scaling4,
  translation4,
} from "../mercatorFrame";

/** A perspective-like matrix from mercator 0..1 space, as MapLibre's mainMatrix is. */
const MAIN = [
  2.1e5,
  3.3e3,
  1.2e-2,
  1.1e-2,
  -4.2e3,
  1.9e5,
  2.0e-2,
  1.8e-2,
  7.0e2,
  -5.0e2,
  9.0e-1,
  8.9e-1,
  -2.1e5 * 0.5,
  -1.9e5 * 0.34,
  -0.2,
  0.3,
];

function apply(m: ArrayLike<number>, v: [number, number, number, number]): number[] {
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let col = 0; col < 4; col++) sum += (m[col * 4 + row] as number) * (v[col] as number);
    out[row] = sum;
  }
  return out;
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, tolerance: number) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++)
    expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThanOrEqual(
      tolerance * Math.max(1, Math.abs(b[i] as number)),
    );
}

describe("mercatorFrame", () => {
  it("uses MapLibre's Earth circumference", () => {
    expect(EARTH_CIRCUMFERENCE_M).toBe(2 * Math.PI * 6371008.8);
  });

  it.each([
    [13.4, 52.5],
    [-122.42, 37.77],
    [151.2, -33.87],
  ])("matches MercatorCoordinate at %f, %f", (lng, lat) => {
    const origin = mercatorOrigin(lng, lat);
    const oracle = MercatorCoordinate.fromLngLat([lng, lat]);
    expect(Math.abs(origin.x - oracle.x)).toBeLessThan(1e-12);
    expect(Math.abs(origin.y - oracle.y)).toBeLessThan(1e-12);
    const units = oracle.meterInMercatorCoordinateUnits();
    expect(Math.abs(origin.metersToUnits - units)).toBeLessThan(1e-12 * units);
  });

  it.each([
    [13.4, 52.5],
    [2.2945, 48.8584],
    [-70.65, -33.45],
  ])("composes the camera matrix as the landmark layer did at %f, %f", (lng, lat) => {
    const oracle = MercatorCoordinate.fromLngLat([lng, lat]);
    const s = oracle.meterInMercatorCoordinateUnits();
    const expected = multiply4(
      multiply4(MAIN, translation4(oracle.x, oracle.y, 0)),
      scaling4(s, -s, s),
    );
    expectClose(cameraMatrix(MAIN, mercatorOrigin(lng, lat)), expected, 1e-12);
  });

  it("places an object relative to the origin, north up, scaled by latitude", () => {
    const origin = mercatorOrigin(13.4, 52.5);
    const anchor: [number, number] = [13.401, 52.501];
    const m = objectMatrix(anchor, 7, origin);
    const at = MercatorCoordinate.fromLngLat(anchor);
    const k = at.meterInMercatorCoordinateUnits() / origin.metersToUnits;
    const [x, y, z] = apply(m, [0, 0, 0, 1]);
    expect(x).toBeCloseTo((at.x - origin.x) / origin.metersToUnits, 6);
    expect(y).toBeCloseTo(-(at.y - origin.y) / origin.metersToUnits, 6);
    expect(z).toBeCloseTo(7 * k, 9);
    const post = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    expectClose(objectMatrix(anchor, 7, origin, post), multiply4(m, post), 1e-12);
  });

  it("writes instance matrices with heading and scale", () => {
    const out = new Float32Array(32);
    instanceMatrix(out, 16, 10, 20, 3, Math.PI / 2, 2, 5);
    const m = out.subarray(16);
    const [x, y, z] = apply(m, [1, 0, 0, 1]);
    expect(x).toBeCloseTo(10, 5);
    expect(y).toBeCloseTo(22, 5);
    expect(z).toBeCloseTo(3, 5);
    expect(apply(m, [0, 0, 1, 1])[2]).toBeCloseTo(8, 5);
    expect(out.subarray(0, 16).every((v) => v === 0)).toBe(true);
  });
});
