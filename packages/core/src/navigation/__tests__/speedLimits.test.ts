import type { MatchResult } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
import { matchSpeedLimitsByPoint, pickSpeedLimit } from "../speedLimits";

function match(partial: Partial<MatchResult>): MatchResult {
  return {
    geometry: [],
    edges: [],
    points: [],
    mode: "driving",
    ...partial,
  };
}

describe("matchSpeedLimitsByPoint", () => {
  it("maps each matched trace point to its edge's speed limit", () => {
    const res = match({
      edges: [
        { length: 100, speedLimit: 50, beginShapeIndex: 0, endShapeIndex: 1 },
        { length: 100, speedLimit: 70, beginShapeIndex: 1, endShapeIndex: 3 },
      ],
      points: [
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
        { lat: 0, lng: 0, type: "matched", edgeIndex: 1 },
        { lat: 0, lng: 0, type: "matched", edgeIndex: 1 },
      ],
    });
    expect(matchSpeedLimitsByPoint(res)).toEqual([50, 70, 70]);
  });

  it("yields null for unmatched points and edges without a limit", () => {
    const res = match({
      edges: [
        { length: 100, beginShapeIndex: 0, endShapeIndex: 1 }, // no speedLimit
        { length: 100, speedLimit: 0, beginShapeIndex: 1, endShapeIndex: 2 }, // 0 = unknown
      ],
      points: [
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
        { lat: 0, lng: 0, type: "matched", edgeIndex: 1 },
        { lat: 0, lng: 0, type: "unmatched" }, // no edgeIndex
      ],
    });
    expect(matchSpeedLimitsByPoint(res)).toEqual([null, null, null]);
  });

  it("returns one entry per trace point", () => {
    const res = match({
      edges: [{ length: 100, speedLimit: 50, beginShapeIndex: 0, endShapeIndex: 1 }],
      points: [
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
      ],
    });
    expect(matchSpeedLimitsByPoint(res)).toHaveLength(2);
  });
});

describe("pickSpeedLimit", () => {
  it("returns the first positive candidate in order", () => {
    expect(pickSpeedLimit(50, 70, 30)).toBe(50);
    expect(pickSpeedLimit(null, 70, 30)).toBe(70);
    expect(pickSpeedLimit(undefined, null, 30)).toBe(30);
  });

  it("treats null, undefined and non-positive values as unknown", () => {
    expect(pickSpeedLimit(0, -1, 60)).toBe(60);
    expect(pickSpeedLimit(null, undefined, null)).toBeNull();
  });
});
