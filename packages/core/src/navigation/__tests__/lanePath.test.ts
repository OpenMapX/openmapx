import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { haversineDistance } from "../../utils/coordinates";
import { LANE_ENTRY_M, laneOffsetAt, offsetLngLat } from "../lanePath";

const path = { fromAlong: 100, toAlong: 180, rejoinAlong: 200, offsetMeters: 3 };

describe("laneOffsetAt", () => {
  it("is zero before the highlight", () => {
    expect(laneOffsetAt(90, path)).toBe(0);
    expect(laneOffsetAt(100, path)).toBe(0);
  });

  it("eases into the lane over the first metres of the highlight", () => {
    expect(laneOffsetAt(100 + LANE_ENTRY_M / 2, path)).toBeCloseTo(1.5, 5);
    expect(laneOffsetAt(100 + LANE_ENTRY_M, path)).toBe(3);
  });

  it("stays in the lane to the junction, then tapers to the rejoin point", () => {
    expect(laneOffsetAt(170, path)).toBe(3);
    expect(laneOffsetAt(190, path)).toBeCloseTo(1.5, 5);
    expect(laneOffsetAt(200, path)).toBe(0);
    expect(laneOffsetAt(250, path)).toBe(0);
  });

  it("keeps the sign for a lane on the left", () => {
    expect(laneOffsetAt(150, { ...path, offsetMeters: -2 })).toBe(-2);
  });

  it("enters no faster than the highlight allows when it is short", () => {
    const short = { fromAlong: 100, toAlong: 106, rejoinAlong: 120, offsetMeters: 3 };
    expect(laneOffsetAt(106, short)).toBe(3);
    expect(laneOffsetAt(103, short)).toBeCloseTo(1.5, 5);
  });
});

describe("offsetLngLat", () => {
  const origin: LngLat = [13.4, 52.5];

  it("moves to the right of the bearing for a positive offset", () => {
    const moved = offsetLngLat(origin, 0, 3);
    expect(haversineDistance(origin, moved)).toBeCloseTo(3, 2);
    expect(moved[0]).toBeGreaterThan(origin[0]);
    expect(moved[1]).toBeCloseTo(origin[1], 7);
  });

  it("moves to the left for a negative offset", () => {
    const moved = offsetLngLat(origin, 90, -3);
    expect(moved[1]).toBeGreaterThan(origin[1]);
  });

  it("returns the point itself without an offset", () => {
    expect(offsetLngLat(origin, 45, 0)).toBe(origin);
  });
});
