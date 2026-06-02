import { describe, expect, it } from "vitest";
import { snapToRoute } from "../snap";

// A 3-point line heading due east along the equator-ish latitude.
const geometry: [number, number][] = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
];

describe("snapToRoute", () => {
  it("snaps a point on the line with ~zero deviation", () => {
    const r = snapToRoute(geometry, [0.0005, 0]);
    expect(r.deviationMeters).toBeLessThan(1);
    expect(r.alongMeters).toBeGreaterThan(50);
    expect(r.alongMeters).toBeLessThan(60); // ~55.6 m at this latitude
  });

  it("reports deviation for an off-line point", () => {
    const r = snapToRoute(geometry, [0.001, 0.001]); // ~111 m north of the line
    expect(r.deviationMeters).toBeGreaterThan(100);
  });
});
