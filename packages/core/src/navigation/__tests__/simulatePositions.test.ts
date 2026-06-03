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
});
