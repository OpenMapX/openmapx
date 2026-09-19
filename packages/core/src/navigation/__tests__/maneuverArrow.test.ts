import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { haversineDistance } from "../../utils/coordinates";
import { cumulativeDistances, positionAt } from "../deadReckon";
import { maneuverArrowLine, maneuverArrowSpans, maneuverArrowTipBearing } from "../maneuverArrow";

// ~1.1 km straight east, so every distance check is against a known geometry.
const geometry: LngLat[] = [
  [0, 0],
  [0.01, 0],
];
const cum = cumulativeDistances(geometry);
const alongMeters = 550;

describe("maneuverArrowSpans", () => {
  it("uses the long spans for driving and motorcycle", () => {
    expect(maneuverArrowSpans("driving")).toEqual({ before: 60, after: 40 });
    expect(maneuverArrowSpans("motorcycle")).toEqual({ before: 60, after: 40 });
  });

  it("uses the short spans for walking and cycling", () => {
    expect(maneuverArrowSpans("walking")).toEqual({ before: 30, after: 20 });
    expect(maneuverArrowSpans("cycling")).toEqual({ before: 30, after: 20 });
  });
});

describe("maneuverArrowLine", () => {
  it("starts before and ends after the maneuver point by the requested spans", () => {
    const line = maneuverArrowLine(geometry, cum, alongMeters, { before: 60, after: 40 })!;
    expect(haversineDistance(line[0], positionAt(geometry, cum, 490).point)).toBeLessThan(1.1);
    expect(haversineDistance(line.at(-1)!, positionAt(geometry, cum, 590).point)).toBeLessThan(1.1);
  });

  it("carries the tip bearing of the last segment", () => {
    const line = maneuverArrowLine(geometry, cum, alongMeters, { before: 60, after: 40 })!;
    // Straight east; the tip bearing is 90 within the polyline's own precision.
    expect(maneuverArrowTipBearing(line)).toBeCloseTo(90, 1);
  });

  it("keeps every route vertex between the two ends, including the first interior one", () => {
    // Vertices every ~55 m; the window 490–590 m must contain the vertices at
    // ~500 and ~555 m and nothing outside it.
    const dense: LngLat[] = Array.from({ length: 21 }, (_, i) => [i * 0.0005, 0]);
    const denseCum = cumulativeDistances(dense);
    const line = maneuverArrowLine(dense, denseCum, alongMeters, { before: 60, after: 40 })!;
    const interior = line.slice(1, -1);
    expect(interior).toEqual(dense.filter((_, i) => denseCum[i] > 490 && denseCum[i] < 590));
    expect(interior.length).toBe(2);
  });

  it("clamps the spans to the route ends", () => {
    const line = maneuverArrowLine(geometry, cum, 5, { before: 60, after: 40 })!;
    expect(line[0]).toEqual(geometry[0]);
  });

  it("returns null when the route is shorter than the minimum", () => {
    const tiny: LngLat[] = [
      [0, 0],
      [0.00005, 0],
    ];
    expect(maneuverArrowLine(tiny, cumulativeDistances(tiny), 3, { before: 60, after: 40 })).toBe(
      null,
    );
  });
});
