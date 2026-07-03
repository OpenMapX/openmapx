import { describe, expect, it } from "vitest";
import type { IsochroneGeometry } from "../types/routing";
import { pointInIsochroneGeometry } from "./pointInPolygon";

const square: IsochroneGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

const squareWithHole: IsochroneGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ],
};

const twoSquares: IsochroneGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
    [
      [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 30],
        [20, 20],
      ],
    ],
  ],
};

describe("pointInIsochroneGeometry", () => {
  it("true for a point inside a polygon", () => {
    expect(pointInIsochroneGeometry([5, 5], square)).toBe(true);
  });
  it("false for a point outside a polygon", () => {
    expect(pointInIsochroneGeometry([15, 5], square)).toBe(false);
  });
  it("false for a point inside a hole", () => {
    expect(pointInIsochroneGeometry([5, 5], squareWithHole)).toBe(false);
  });
  it("true for a point in the second polygon of a MultiPolygon", () => {
    expect(pointInIsochroneGeometry([25, 25], twoSquares)).toBe(true);
  });
  it("false for a point in neither polygon of a MultiPolygon", () => {
    expect(pointInIsochroneGeometry([15, 15], twoSquares)).toBe(false);
  });
});
