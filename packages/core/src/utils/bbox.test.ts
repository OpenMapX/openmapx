import { describe, expect, it } from "vitest";
import { bboxAroundPoint, bboxCacheKey } from "./bbox";

describe("bboxAroundPoint", () => {
  it("returns a box centered on the point", () => {
    const bbox = bboxAroundPoint([13.405, 52.52], 1000);
    expect((bbox.west + bbox.east) / 2).toBeCloseTo(13.405, 5);
    expect((bbox.south + bbox.north) / 2).toBeCloseTo(52.52, 5);
  });

  it("spans ~2x the radius in latitude (north-south)", () => {
    const bbox = bboxAroundPoint([13.405, 52.52], 1000);
    const latSpanMetres = (bbox.north - bbox.south) * 111_320;
    expect(latSpanMetres).toBeCloseTo(2000, -1);
  });

  it("widens longitude span with latitude (cos correction)", () => {
    const equator = bboxAroundPoint([0, 0], 1000);
    const high = bboxAroundPoint([0, 60], 1000);
    const equatorLonSpan = equator.east - equator.west;
    const highLonSpan = high.east - high.west;
    expect(highLonSpan).toBeCloseTo(equatorLonSpan * 2, 4);
  });
});

describe("bboxCacheKey", () => {
  // A city-level viewport: the case a fixed 0.01deg grid collapses.
  const city = { south: 50.769, west: 6.07, north: 50.786, east: 6.098 };

  it("gives neighbouring city viewports distinct keys", () => {
    const shifted = { south: 50.774, west: 6.075, north: 50.791, east: 6.103 };
    expect(bboxCacheKey(city)).not.toBe(bboxCacheKey(shifted));
  });

  it("still collapses a pan far smaller than the viewport", () => {
    const nudged = { south: 50.76901, west: 6.07001, north: 50.78601, east: 6.09801 };
    expect(bboxCacheKey(nudged)).toBe(bboxCacheKey(city));
  });

  it("scales tolerance with the viewport, so continent-scale boxes still coalesce", () => {
    const europe = { south: 35, west: -10, north: 60, east: 30 };
    const nudgedEurope = { south: 35.05, west: -9.95, north: 60.05, east: 30.05 };
    expect(bboxCacheKey(nudgedEurope)).toBe(bboxCacheKey(europe));
    const elsewhere = { south: 20, west: -10, north: 45, east: 30 };
    expect(bboxCacheKey(elsewhere)).not.toBe(bboxCacheKey(europe));
  });

  it("does not divide by zero on a degenerate box", () => {
    expect(bboxCacheKey({ south: 5, west: 5, north: 5, east: 5 })).toBeTypeOf("string");
  });
});
