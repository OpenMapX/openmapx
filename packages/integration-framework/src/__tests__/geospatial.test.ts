import { describe, expect, it } from "vitest";
import {
  clampViewportBoundingBox,
  parsePositiveRadius,
  parseWgs84BoundingBox,
  parseWgs84Point,
  parseWgs84PointList,
} from "../geospatial";

describe("shared geospatial input validation", () => {
  it.each([
    ["non-finite longitude", Number.POSITIVE_INFINITY, 0],
    ["longitude below range", -180.01, 0],
    ["longitude above range", 180.01, 0],
    ["latitude below range", 0, -90.01],
    ["latitude above range", 0, 90.01],
  ])("rejects a point with %s", (_label, lng, lat) => {
    expect(parseWgs84Point(lng, lat)).toBeNull();
  });

  it("accepts numeric strings but can constrain latitude for radius calculations", () => {
    expect(parseWgs84Point("13.4", "52.5")).toEqual([13.4, 52.5]);
    expect(parseWgs84Point(0, 89, { maxAbsLatitude: 85 })).toBeNull();
  });

  it.each([
    ["reversed latitude", { west: 10, south: 5, east: 11, north: 4 }],
    ["reversed longitude", { west: 11, south: 4, east: 10, north: 5 }],
    ["out-of-range coordinate", { west: -181, south: 4, east: 10, north: 5 }],
    ["excessive latitude span", { west: 0, south: 0, east: 5, north: 31 }],
    ["excessive longitude span", { west: 0, south: 0, east: 61, north: 5 }],
    ["excessive area", { west: 0, south: 0, east: 40, north: 25 }],
  ])("rejects a bbox with %s", (_label, bbox) => {
    expect(
      parseWgs84BoundingBox(bbox, {
        maxLatitudeSpan: 30,
        maxLongitudeSpan: 60,
        maxArea: 900,
      }),
    ).toBeNull();
  });

  it("returns a canonical west/south/east/north tuple", () => {
    expect(
      parseWgs84BoundingBox(
        { west: "13.3", south: "52.4", east: "13.5", north: "52.6" },
        { maxLatitudeSpan: 30, maxLongitudeSpan: 60, maxArea: 900 },
      ),
    ).toEqual([13.3, 52.4, 13.5, 52.6]);
  });

  it("validates positive bounded radii", () => {
    expect(parsePositiveRadius(undefined, { defaultValue: 500, max: 2_000 })).toBe(500);
    expect(parsePositiveRadius(-1, { defaultValue: 500, max: 2_000 })).toBeNull();
    expect(parsePositiveRadius(2_001, { defaultValue: 500, max: 2_000 })).toBeNull();
    expect(parsePositiveRadius("2000", { defaultValue: 500, max: 2_000 })).toBe(2_000);
  });

  it("validates every point and enforces operation-specific list bounds", () => {
    expect(
      parseWgs84PointList(
        [
          [13.4, 52.5],
          [13.5, 52.6],
        ],
        { min: 2, max: 3 },
      ),
    ).toEqual([
      [13.4, 52.5],
      [13.5, 52.6],
    ]);
    expect(parseWgs84PointList([[13.4, 52.5]], { min: 2, max: 3 })).toBeNull();
    expect(
      parseWgs84PointList(
        [
          [13.4, 52.5],
          [13.5, 52.6],
          [13.6, 52.7],
          [13.7, 52.8],
        ],
        { min: 2, max: 3 },
      ),
    ).toBeNull();
    expect(
      parseWgs84PointList(
        [
          [13.4, 52.5],
          [Number.NaN, 52.6],
        ],
        { min: 2, max: 3 },
      ),
    ).toBeNull();
  });
});

describe("clampViewportBoundingBox", () => {
  const limits = { maxLatitudeSpan: 30, maxLongitudeSpan: 60, maxArea: 900 };

  it("clamps a world-scale viewport around its centre instead of rejecting it", () => {
    const box = clampViewportBoundingBox({ west: -540, south: -85, east: 540, north: 85 }, limits);
    expect(box).not.toBeNull();
    const [w, s, e, n] = box as [number, number, number, number];
    expect(e - w).toBeCloseTo(Math.sqrt(900 * 2));
    expect(n - s).toBeCloseTo(Math.sqrt(900 / 2));
    expect((w + e) / 2).toBeCloseTo(0);
    expect((s + n) / 2).toBeCloseTo(0);
  });

  it("wraps world-copy longitudes and keeps the wider side of an antimeridian crossing", () => {
    const box = clampViewportBoundingBox({ west: 170, south: -45, east: 200, north: -35 }, limits);
    expect(box).toEqual([-180, -45, -160, -35]);
  });

  it("shrinks an oversized area proportionally and keeps in-limit boxes untouched", () => {
    expect(clampViewportBoundingBox({ west: 5, south: 47, east: 15, north: 55 }, limits)).toEqual([
      5, 47, 15, 55,
    ]);
    const europe = clampViewportBoundingBox({ west: -20, south: 35, east: 40, north: 70 }, limits);
    expect(europe).not.toBeNull();
    const [w, s, e, n] = europe as [number, number, number, number];
    expect((e - w) * (n - s)).toBeLessThanOrEqual(900.0001);
    expect((w + e) / 2).toBeCloseTo(10);
    expect((s + n) / 2).toBeCloseTo(52.5);
  });

  it("rejects non-finite input only", () => {
    expect(clampViewportBoundingBox({ west: "x", south: 1, east: 2, north: 3 }, limits)).toBeNull();
  });
});
