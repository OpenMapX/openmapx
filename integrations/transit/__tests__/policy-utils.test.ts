import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { isRefreshEligible, routeZoomBucket } from "../index.js";

function leg(mode: TripLeg["mode"], fromStop?: string, toStop?: string): TripLeg {
  return {
    mode,
    startTime: "2026-07-15T10:00:00Z",
    endTime: "2026-07-15T10:05:00Z",
    from: { name: "A", lat: 52, lng: 13, stopId: fromStop },
    to: { name: "B", lat: 52.1, lng: 13.1, stopId: toStop },
    geometry: { type: "LineString", coordinates: [] },
  };
}

function itinerary(legs: TripLeg[]): TripItinerary {
  return {
    id: "itinerary-1",
    duration: 300,
    startTime: "2026-07-15T10:00:00Z",
    endTime: "2026-07-15T10:05:00Z",
    transfers: 0,
    walkDistance: 0,
    legs,
  };
}

describe("routeZoomBucket", () => {
  it.each([
    [undefined, 12],
    ["not-a-number", 12],
    ["-5", 10],
    ["11.9", 10],
    ["12", 12],
    ["14.8", 14],
    ["99", 16],
  ])("maps %s to a bounded cache bucket", (raw, expected) => {
    expect(routeZoomBucket(raw)).toBe(expected);
  });
});

describe("isRefreshEligible", () => {
  it("accepts walk-ended and station-to-station itineraries", () => {
    expect(isRefreshEligible(itinerary([leg("walking"), leg("rail"), leg("walking")]))).toBe(true);
    expect(isRefreshEligible(itinerary([leg("rail", "stop-a", "stop-b")]))).toBe(true);
  });

  it.each(["cycling", "driving"] as const)("rejects %s end legs", (mode) => {
    expect(isRefreshEligible(itinerary([leg(mode)]))).toBe(false);
  });

  it("rejects rental and missing refresh identity", () => {
    const rental = leg("cycling");
    rental.rental = { systemId: "bike-system", formFactor: "BICYCLE" };
    expect(isRefreshEligible(itinerary([rental]))).toBe(false);
    expect(isRefreshEligible({ ...itinerary([leg("walking")]), id: undefined })).toBe(false);
  });
});
