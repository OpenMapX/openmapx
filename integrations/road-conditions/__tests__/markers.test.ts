import { describe, expect, it } from "vitest";
import { markerImageId, parseMarkerImageId, representativePoint } from "../markers.js";

describe("representativePoint", () => {
  it("returns the point itself for Point geometry", () => {
    expect(representativePoint({ type: "Point", coordinates: [7.1, 50.7] })).toEqual([7.1, 50.7]);
  });

  it("returns the length-midpoint of a LineString (one marker per incident)", () => {
    // A north-south segment from lat 50.70 to 50.72; midpoint ~50.71.
    const p = representativePoint({
      type: "LineString",
      coordinates: [
        [7.0, 50.7],
        [7.0, 50.72],
      ],
    });
    expect(p).not.toBeNull();
    expect(p?.[0]).toBeCloseTo(7.0, 5);
    expect(p?.[1]).toBeCloseTo(50.71, 4);
  });

  it("picks the longest line's midpoint for MultiLineString", () => {
    const p = representativePoint({
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [0, 0.001],
        ], // short
        [
          [7, 50],
          [7, 50.02],
        ], // long → midpoint ~50.01
      ],
    });
    expect(p?.[1]).toBeCloseTo(50.01, 4);
  });

  it("returns null for unknown/empty geometry", () => {
    expect(representativePoint(null)).toBeNull();
    expect(representativePoint({ type: "GeometryCollection", coordinates: [] })).toBeNull();
  });
});

describe("markerImageId", () => {
  it("builds a stable rc:type:severity id", () => {
    expect(markerImageId("road_closure", "high")).toBe("rc:road_closure:high");
  });

  it("falls back to other/unknown for unrecognized values", () => {
    expect(markerImageId("nope", "weird")).toBe("rc:other:unknown");
  });

  it("round-trips through parseMarkerImageId", () => {
    expect(parseMarkerImageId("rc:road_closure:high")).toEqual({
      type: "road_closure",
      severity: "high",
    });
    expect(parseMarkerImageId("not-a-marker")).toBeNull();
  });
});
