import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { bboxCenter, sortResultsByIntent } from "../sortResults";

interface TestPlace {
  id: string;
  coordinates: LngLat;
  rating?: number;
}

const REFERENCE: LngLat = [0, 0];

// Roughly increasing distance from [0,0]: near < mid < far.
const NEAR: TestPlace = { id: "near", coordinates: [0.01, 0.01] };
const MID: TestPlace = { id: "mid", coordinates: [0.5, 0.5] };
const FAR: TestPlace = { id: "far", coordinates: [2, 2] };

describe("bboxCenter", () => {
  it("returns the midpoint of a bounding box as [lng, lat]", () => {
    expect(bboxCenter({ west: -10, east: 10, south: -4, north: 8 })).toEqual([0, 2]);
  });
});

describe("sortResultsByIntent", () => {
  it("leaves order unchanged for relevance and returns the same array reference", () => {
    const input = [FAR, NEAR, MID];
    expect(sortResultsByIntent(input, "relevance", REFERENCE)).toBe(input);
  });

  it("leaves order unchanged for undefined sort", () => {
    const input = [FAR, NEAR, MID];
    expect(sortResultsByIntent(input, undefined, REFERENCE)).toBe(input);
  });

  it("passes undefined results through untouched", () => {
    expect(sortResultsByIntent(undefined, "distance", REFERENCE)).toBeUndefined();
  });

  it("sorts by ascending distance from the reference point", () => {
    const sorted = sortResultsByIntent([FAR, NEAR, MID], "distance", REFERENCE);
    expect(sorted?.map((p) => p.id)).toEqual(["near", "mid", "far"]);
  });

  it("does not mutate the input array when sorting by distance", () => {
    const input = [FAR, NEAR, MID];
    const sorted = sortResultsByIntent(input, "distance", REFERENCE);
    expect(input.map((p) => p.id)).toEqual(["far", "near", "mid"]);
    expect(sorted).not.toBe(input);
  });

  it("is a no-op for distance when there is no reference point", () => {
    const input = [FAR, NEAR, MID];
    expect(sortResultsByIntent(input, "distance", null)).toBe(input);
  });

  it("is a no-op for rating when no result carries a rating", () => {
    const input = [FAR, NEAR, MID];
    expect(sortResultsByIntent(input, "rating", REFERENCE)).toBe(input);
  });

  it("sorts by descending rating when ratings are present, unrated last", () => {
    const a: TestPlace = { id: "a", coordinates: [0, 0], rating: 3.5 };
    const b: TestPlace = { id: "b", coordinates: [0, 0], rating: 4.8 };
    const c: TestPlace = { id: "c", coordinates: [0, 0] };
    const sorted = sortResultsByIntent([a, b, c], "rating", REFERENCE);
    expect(sorted?.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});
