import { describe, expect, it } from "vitest";
import type { LngLat } from "../types/geometry";
import { stopsUntilAlight } from "./transitProgress";

// A short leg running north along the prime meridian.
const legWest: LngLat[] = [
  [0, 0],
  [0, 0.01],
  [0, 0.02],
];
describe("stopsUntilAlight", () => {
  const stops = [
    { lat: 0, lng: 0, name: "Origin" },
    { lat: 0.005, lng: 0, name: "Mid 1" },
    { lat: 0.012, lng: 0, name: "Mid 2" },
    { lat: 0.02, lng: 0, name: "Alight" },
  ];

  it("returns the first stop ahead and the remaining count", () => {
    // Snapped just past the origin → next is Mid 1, three stops remain.
    const r = stopsUntilAlight(legWest, stops, [0, 0.001]);
    expect(r.nextStopName).toBe("Mid 1");
    expect(r.stopsRemaining).toBe(3);
  });

  it("advances as the position moves along the leg", () => {
    const r = stopsUntilAlight(legWest, stops, [0, 0.008]);
    expect(r.nextStopName).toBe("Mid 2");
    expect(r.stopsRemaining).toBe(2);
  });

  it("reports the final stop when approaching the end", () => {
    const r = stopsUntilAlight(legWest, stops, [0, 0.015]);
    expect(r.nextStopName).toBe("Alight");
    expect(r.stopsRemaining).toBe(1);
  });

  it("returns nulls past the last stop", () => {
    const r = stopsUntilAlight(legWest, stops, [0, 0.021]);
    expect(r.nextStopName).toBeNull();
    expect(r.stopsRemaining).toBe(0);
  });

  it("returns nulls gracefully when stops are empty", () => {
    const r = stopsUntilAlight(legWest, [], [0, 0.01]);
    expect(r.nextStopName).toBeNull();
    expect(r.stopsRemaining).toBe(0);
  });
});
