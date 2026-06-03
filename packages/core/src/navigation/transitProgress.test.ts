import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import type { LngLat } from "../types/geometry";
import { computeTransitProgress, stopsUntilAlight } from "./transitProgress";

function leg(coords: LngLat[], partial: Partial<TripLeg> = {}): TripLeg {
  return {
    mode: "bus",
    startTime: "2026-06-01T10:00:00Z",
    endTime: "2026-06-01T10:30:00Z",
    from: { name: "A", lat: coords[0][1], lng: coords[0][0] },
    to: {
      name: "B",
      lat: coords[coords.length - 1][1],
      lng: coords[coords.length - 1][0],
    },
    geometry: { type: "LineString", coordinates: coords },
    ...partial,
  };
}

function itinerary(legs: TripLeg[]): TripItinerary {
  return {
    duration: 1800,
    startTime: "2026-06-01T10:00:00Z",
    endTime: "2026-06-01T10:30:00Z",
    transfers: legs.length - 1,
    walkDistance: 0,
    legs,
  };
}

// Two legs running along distinct longitudes so the nearest-leg test is
// unambiguous: leg 0 is the west line (lng ~0), leg 1 the east line (lng ~1).
const legWest: LngLat[] = [
  [0, 0],
  [0, 0.01],
  [0, 0.02],
];
const legEast: LngLat[] = [
  [1, 0],
  [1, 0.01],
  [1, 0.02],
];

describe("computeTransitProgress", () => {
  it("selects the nearest leg across a 2-leg itinerary", () => {
    const it = itinerary([leg(legWest), leg(legEast)]);
    const onEast = computeTransitProgress(it, [1.0001, 0.005]);
    expect(onEast.currentLegIndex).toBe(1);
    const onWest = computeTransitProgress(it, [0.0001, 0.005]);
    expect(onWest.currentLegIndex).toBe(0);
  });

  it("reports fractionAlongLeg roughly matching position", () => {
    const it = itinerary([leg(legWest)]);
    const mid = computeTransitProgress(it, [0, 0.01]);
    expect(mid.fractionAlongLeg).toBeGreaterThan(0.4);
    expect(mid.fractionAlongLeg).toBeLessThan(0.6);
  });

  it("flags arrived near the end of the last leg", () => {
    const it = itinerary([leg(legWest), leg(legEast)]);
    const nearEnd = computeTransitProgress(it, [1, 0.0199]);
    expect(nearEnd.currentLegIndex).toBe(1);
    expect(nearEnd.arrived).toBe(true);
  });

  it("does not flag arrived when still on an earlier leg", () => {
    const it = itinerary([leg(legWest), leg(legEast)]);
    const onFirst = computeTransitProgress(it, [0, 0.0199]);
    expect(onFirst.currentLegIndex).toBe(0);
    expect(onFirst.arrived).toBe(false);
  });

  it("handles degenerate legs gracefully", () => {
    const it = itinerary([leg([[0, 0]])]);
    const p = computeTransitProgress(it, [0, 0]);
    expect(p.currentLegIndex).toBe(0);
    expect(p.arrived).toBe(false);
  });
});

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
