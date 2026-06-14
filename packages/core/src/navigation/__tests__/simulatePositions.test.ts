import { describe, expect, it } from "vitest";
import { simulatePositions } from "../simulatePositions";

const geometry: [number, number][] = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
];

describe("simulatePositions", () => {
  it("emits fixes from start to end with increasing timestamps", () => {
    const fixes = simulatePositions(geometry, { stepMeters: 20, startMs: 1000, intervalMs: 1000 });
    expect(fixes.length).toBeGreaterThan(2);
    expect(fixes[0].coords[0]).toBeCloseTo(0, 5);
    expect(fixes[fixes.length - 1].coords[0]).toBeCloseTo(0.002, 4);
    expect(fixes[1].timestampMs - fixes[0].timestampMs).toBe(1000);
  });

  it("can inject lateral offset to simulate going off-route", () => {
    const fixes = simulatePositions(geometry, { stepMeters: 20, offsetMeters: 100 });
    expect(Math.abs(fixes[1].coords[1])).toBeGreaterThan(0); // pushed off the line
  });

  it("populates a realistic heading and speed on each fix", () => {
    const fixes = simulatePositions(geometry, { stepMeters: 20, intervalMs: 1000 });
    // Route runs due east → heading ~90°; speed = 20 m per 1 s = 20 m/s.
    expect(fixes[0].heading).toBeCloseTo(90, 0);
    expect(fixes[0].speed).toBeCloseTo(20, 5);
  });

  it("pins speed and derives spacing when speedMps is given", () => {
    const fixes = simulatePositions(geometry, { speedMps: 10, intervalMs: 1000 });
    // 10 m/s for 1 s → ~10 m steps; every fix reports 10 m/s.
    expect(fixes.every((f) => f.speed === 10)).toBe(true);
    expect(haversineish(fixes[0].coords, fixes[1].coords)).toBeGreaterThan(8);
    expect(haversineish(fixes[0].coords, fixes[1].coords)).toBeLessThan(12);
  });
});

/** Rough metre distance between two close lng/lat points (equirectangular). */
function haversineish(a: [number, number], b: [number, number]): number {
  const mPerDeg = 111_320;
  const dx = (b[0] - a[0]) * mPerDeg * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * mPerDeg;
  return Math.sqrt(dx * dx + dy * dy);
}
