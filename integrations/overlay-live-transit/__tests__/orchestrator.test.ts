import { describe, expect, it } from "vitest";
import { preferObservedByTrip } from "../orchestrator.js";
import type { LiveTransitVehicle } from "../types.js";

function vehicle(partial: Partial<LiveTransitVehicle> & { id: string }): LiveTransitVehicle {
  return {
    provider: "test",
    sourceId: "test",
    mode: "bus",
    displayLabel: partial.id,
    lat: 0,
    lng: 0,
    ...partial,
  } as LiveTransitVehicle;
}

describe("preferObservedByTrip", () => {
  it("drops an interpolated vehicle when an observed fix exists for the same trip", () => {
    const observed = vehicle({ id: "gps:1", tripId: "trip-1", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:1", tripId: "trip-1", positionKind: "interpolated" });
    const result = preferObservedByTrip([interpolated, observed]);
    expect(result).toEqual([observed]);
  });

  it("keeps an interpolated vehicle when no observed fix exists for its trip", () => {
    const interpolated = vehicle({ id: "ms:2", tripId: "trip-2", positionKind: "interpolated" });
    expect(preferObservedByTrip([interpolated])).toEqual([interpolated]);
  });

  it("treats an undefined positionKind as observed (never dropped)", () => {
    const legacy = vehicle({ id: "gps:3", tripId: "trip-3" });
    const interpolated = vehicle({ id: "ms:3", tripId: "trip-3", positionKind: "interpolated" });
    expect(preferObservedByTrip([legacy, interpolated])).toEqual([legacy]);
  });

  it("never drops vehicles that have no tripId", () => {
    const a = vehicle({ id: "ms:4", positionKind: "interpolated" });
    const b = vehicle({ id: "gps:4", positionKind: "observed" });
    expect(preferObservedByTrip([a, b])).toEqual([a, b]);
  });

  it("keeps observed and interpolated for different trips", () => {
    const observed = vehicle({ id: "gps:5", tripId: "trip-5", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:6", tripId: "trip-6", positionKind: "interpolated" });
    expect(preferObservedByTrip([observed, interpolated])).toHaveLength(2);
  });
});
