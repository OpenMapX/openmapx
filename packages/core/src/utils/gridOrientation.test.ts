import { describe, expect, it } from "vitest";
import { bearingDelta, dominantGridBearing, nearestGridBearing } from "./gridOrientation";

function grid(angle: number, count = 40, jitter = 0): { bearing: number; weight: number }[] {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const axis = i % 2 === 0 ? angle : angle + 90;
    const noise = jitter * Math.sin(i * 1.7);
    out.push({ bearing: (axis + noise + (i % 4 < 2 ? 0 : 180) + 360) % 360, weight: 10 });
  }
  return out;
}

describe("dominantGridBearing", () => {
  it("finds a north-aligned grid with full confidence", () => {
    const result = dominantGridBearing(grid(0));
    expect(result?.bearing).toBeCloseTo(0, 5);
    expect(result?.confidence).toBeCloseTo(1, 5);
    expect(result?.weight).toBe(400);
  });

  it("finds a diagonal grid within half a degree despite jitter", () => {
    const result = dominantGridBearing(grid(29, 60, 3));
    expect(result?.bearing).toBeGreaterThan(28.5);
    expect(result?.bearing).toBeLessThan(29.5);
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it("reports no confidence for a roundabout of evenly spread bearings", () => {
    const samples = Array.from({ length: 36 }, (_, i) => ({ bearing: i * 10, weight: 5 }));
    expect(dominantGridBearing(samples)?.confidence).toBeLessThan(0.05);
  });

  it("lets a dominant grid outweigh a diagonal motorway", () => {
    const samples = [...grid(0), { bearing: 45, weight: 60 }];
    const result = dominantGridBearing(samples);
    expect(result?.bearing).toBeLessThan(3);
    // A 45° sample sits exactly opposite the grid once folded, so its weight
    // cancels an equal share of the grid's: 340 of 460.
    expect(result?.confidence).toBeCloseTo(340 / 460, 12);
  });

  it("ignores non-positive weights and returns null without usable samples", () => {
    expect(
      dominantGridBearing([
        { bearing: 10, weight: 0 },
        { bearing: Number.NaN, weight: 5 },
      ]),
    ).toBeNull();
    expect(dominantGridBearing([])).toBeNull();
  });
});

describe("bearingDelta", () => {
  it("is signed and wraps across the seam", () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
    expect(bearingDelta(0, 180)).toBe(180);
  });
});

describe("nearestGridBearing", () => {
  it("picks the candidate with the smallest rotation, across the seam", () => {
    expect(nearestGridBearing(0, 29)).toBe(29);
    expect(nearestGridBearing(0, 61)).toBe(331);
    expect(nearestGridBearing(350, 29)).toBe(29);
    expect(nearestGridBearing(100, 29)).toBe(119);
  });
});
