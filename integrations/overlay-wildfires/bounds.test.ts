import { describe, expect, it } from "vitest";
import { densityCellDeg, normalizeViewport } from "./bounds.js";

describe("normalizeViewport", () => {
  it("expands and quantizes a normal viewport", () => {
    expect(
      normalizeViewport({ west: "10", south: "45", east: "12", north: "47", zoom: "7" }),
    ).toEqual({ west: 9.8, south: 44.8, east: 12.2, north: 47.2, zoom: 7 });
  });

  it("rejects non-finite and inverted latitude bounds", () => {
    expect(() =>
      normalizeViewport({ west: "x", south: "45", east: "12", north: "47", zoom: "7" }),
    ).toThrow("Invalid bbox");
    expect(() =>
      normalizeViewport({ west: "10", south: "50", east: "12", north: "40", zoom: "7" }),
    ).toThrow("Invalid bbox");
  });

  it("clamps Web Mercator latitude and supported zoom", () => {
    expect(
      normalizeViewport({ west: "-190", south: "-90", east: "190", north: "90", zoom: "99" }),
    ).toMatchObject({
      west: -180,
      south: -85.051129,
      east: 180,
      north: 85.051129,
      zoom: 22,
    });
  });

  it.each([
    [170, -170, 168, -168],
    [31, -31, 1, -1],
    [30.1, -30.1, -180, 180],
    [30, -30, -180, 180],
    [10, -10, -180, 180],
    [1, -1, -180, 180],
  ])(
    "expands wrapped longitude interval %s..%s without collapsing it",
    (west, east, expectedWest, expectedEast) => {
      expect(normalizeViewport({ west, south: -10, east, north: 10, zoom: 5 })).toMatchObject({
        west: expectedWest,
        east: expectedEast,
      });
    },
  );
});

it.each([
  [0, 2],
  [3, 2],
  [4, 1],
  [5, 0.5],
  [6, 0.25],
])("uses density cells for zoom %i of %f degrees", (zoom, expected) =>
  expect(densityCellDeg(zoom)).toBe(expected),
);
