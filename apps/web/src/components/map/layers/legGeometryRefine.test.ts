import type { TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { shouldRefineLegGeometry } from "./legGeometryRefine";

function leg(overrides: Partial<TripLeg>): TripLeg {
  return {
    mode: "rail",
    startTime: "2026-07-19T14:58:00Z",
    endTime: "2026-07-19T15:11:00Z",
    from: { name: "A", lat: 52.5, lng: 13.3 },
    to: { name: "B", lat: 52.52, lng: 13.41 },
    geometry: {
      type: "LineString",
      coordinates: [
        [13.3, 52.5],
        [13.41, 52.52],
      ],
    },
    tripId: "ms:trip-1",
    ...overrides,
  } as TripLeg;
}

describe("shouldRefineLegGeometry", () => {
  it("skips walking legs", () => {
    expect(shouldRefineLegGeometry(leg({ mode: "walking", tripId: undefined }))).toBe(false);
  });

  it("skips legs without a tripId", () => {
    expect(shouldRefineLegGeometry(leg({ tripId: undefined }))).toBe(false);
  });

  it("skips MOTIS legs that already embed a detailed polyline", () => {
    // Berlin S-Bahn leg: 2 intermediate stops, 112-point track polyline.
    const coords = Array.from({ length: 112 }, (_, i) => [13.3 + i * 0.001, 52.5]) as [
      number,
      number,
    ][];
    const l = leg({
      _intermediateStopCount: 2,
      geometry: { type: "LineString", coordinates: coords },
    });
    expect(shouldRefineLegGeometry(l)).toBe(false);
  });

  it("skips even a modestly-detailed polyline (more vertices than stops+2)", () => {
    // U5 leg observed in prod: 5 intermediate stops, 9 vertices.
    const coords = Array.from({ length: 9 }, (_, i) => [13.3 + i * 0.001, 52.5]) as [
      number,
      number,
    ][];
    const l = leg({
      mode: "subway",
      _intermediateStopCount: 5,
      geometry: { type: "LineString", coordinates: coords },
    });
    expect(shouldRefineLegGeometry(l)).toBe(false);
  });

  it("refines coarse stop-connected geometry (DB Vendo / Entur)", () => {
    // Coarse inline geometry: vertices only join the stops.
    const coords = [
      [13.3, 52.5],
      [13.35, 52.51],
      [13.41, 52.52],
    ] as [number, number][];
    const l = leg({
      tripId: "db:trip-9",
      _intermediateStopCount: 1,
      geometry: { type: "LineString", coordinates: coords },
    });
    expect(shouldRefineLegGeometry(l)).toBe(true);
  });

  it("refines a straight two-point fallback", () => {
    const l = leg({ tripId: "db:trip-9", _intermediateStopCount: 3 });
    expect(shouldRefineLegGeometry(l)).toBe(true);
  });

  it("defaults to refining when the stop count is unreported (e.g. GTFS-local)", () => {
    const coords = Array.from({ length: 20 }, (_, i) => [13.3 + i * 0.001, 52.5]) as [
      number,
      number,
    ][];
    const l = leg({
      tripId: "g-berlin:trip-2",
      _intermediateStopCount: undefined,
      geometry: { type: "LineString", coordinates: coords },
    });
    expect(shouldRefineLegGeometry(l)).toBe(true);
  });
});
