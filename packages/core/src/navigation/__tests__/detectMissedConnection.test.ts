import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import type { TransitProgress } from "../transitProgress";
import { detectMissedConnection } from "../transitProgress";

function leg(partial: Partial<TripLeg>): TripLeg {
  return {
    mode: "bus",
    startTime: "",
    endTime: "",
    from: { name: "", lat: 0, lng: 0 },
    to: { name: "", lat: 0, lng: 0 },
    geometry: { type: "LineString", coordinates: [] },
    ...partial,
  };
}

function progress(partial: Partial<TransitProgress>): TransitProgress {
  return {
    currentLegIndex: 0,
    snapped: [0, 0],
    fractionAlongLeg: 0,
    deviationMeters: 0,
    arrived: false,
    ...partial,
  };
}

const T0 = Date.parse("2026-06-06T10:00:00Z");

describe("detectMissedConnection", () => {
  it("flags a transit leg whose departure passed beyond the grace window and was not boarded", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [
        leg({ mode: "walking" }),
        leg({ mode: "bus", tripId: "x:1", startTime: new Date(T0).toISOString() }),
      ],
    };
    // 3 minutes after the bus was due, still on the walk leg → missed.
    const now = T0 + 3 * 60_000;
    expect(detectMissedConnection(itin, progress({ currentLegIndex: 0 }), now)).toBe(true);
  });

  it("does not flag when the departure is still within the grace window", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [leg({ mode: "bus", tripId: "x:1", startTime: new Date(T0).toISOString() })],
    };
    const now = T0 + 60_000; // 1 min late, under the 2 min grace
    expect(detectMissedConnection(itin, progress({ currentLegIndex: 0 }), now)).toBe(false);
  });

  it("does not flag once the traveller has boarded (progressed along the leg)", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [leg({ mode: "bus", tripId: "x:1", startTime: new Date(T0).toISOString() })],
    };
    const now = T0 + 10 * 60_000;
    const onBoard = progress({ currentLegIndex: 0, fractionAlongLeg: 0.5, deviationMeters: 20 });
    expect(detectMissedConnection(itin, onBoard, now)).toBe(false);
  });

  it("does not flag the current leg on a GPS deviation spike (low fraction, large deviation)", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [leg({ mode: "bus", tripId: "x:1", startTime: new Date(T0).toISOString() })],
    };
    const now = T0 + 10 * 60_000; // well past departure — you're riding it
    // Snapped early on the leg with a big deviation (tunnel / urban-canyon spike).
    const spike = progress({ currentLegIndex: 0, fractionAlongLeg: 0.05, deviationMeters: 400 });
    expect(detectMissedConnection(itin, spike, now)).toBe(false);
  });

  it("flags the current transit leg when waiting at the stop after it departed (low fraction, small deviation)", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [leg({ mode: "bus", tripId: "x:1", startTime: new Date(T0).toISOString() })],
    };
    const now = T0 + 5 * 60_000;
    const atStop = progress({ currentLegIndex: 0, fractionAlongLeg: 0, deviationMeters: 10 });
    expect(detectMissedConnection(itin, atStop, now)).toBe(true);
  });

  it("ignores non-transit legs (no tripId)", () => {
    const itin: TripItinerary = {
      duration: 0,
      startTime: "",
      endTime: "",
      transfers: 0,
      walkDistance: 0,
      legs: [leg({ mode: "walking", startTime: new Date(T0).toISOString() })],
    };
    expect(detectMissedConnection(itin, progress({}), T0 + 60 * 60_000)).toBe(false);
  });
});
