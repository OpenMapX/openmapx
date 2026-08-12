import { describe, expect, it } from "vitest";
import {
  dedupeByFeatureId,
  nifcOffsetForZoom,
  normalizeViewport,
  splitAntimeridian,
} from "./bounds.js";

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

it("splits an antimeridian viewport", () => {
  expect(splitAntimeridian({ west: 170, south: -10, east: -170, north: 10, zoom: 5 })).toEqual([
    { west: 170, south: -10, east: 180, north: 10, zoom: 5 },
    { west: -180, south: -10, east: -170, north: 10, zoom: 5 },
  ]);
});

it.each([
  [3, 0.02],
  [5, 0.01],
  [7, 0.005],
  [9, 0.001],
])("uses the NIFC simplification offset for zoom %i", (zoom, expected) =>
  expect(nifcOffsetForZoom(zoom)).toBe(expected),
);

it("deduplicates split-query features by provider id", () => {
  expect(
    dedupeByFeatureId([
      {
        type: "FeatureCollection",
        features: [{ type: "Feature", id: "nifc:1", properties: {}, geometry: null }],
      },
      {
        type: "FeatureCollection",
        features: [{ type: "Feature", id: "nifc:1", properties: {}, geometry: null }],
      },
    ]).features,
  ).toHaveLength(1);
});
