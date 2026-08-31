import type { RealtimeProvider } from "@openmapx/integration-framework";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createLiveTransitOrchestrator, preferObservedByTrip } from "../orchestrator.js";

function vehicle(partial: Partial<LiveTransitVehicle> & { id: string }): LiveTransitVehicle {
  return {
    provider: "test",
    sourceId: "test",
    mode: "bus",
    displayLabel: partial.id,
    positionKind: "observed",
    lat: 0,
    lng: 0,
    ...partial,
  };
}

describe("createLiveTransitOrchestrator", () => {
  it("consumes the canonical realtime-provider vehicle contract", async () => {
    const expected = vehicle({ id: "gps:contract", positionKind: "observed" });
    const provider: RealtimeProvider = {
      id: "contract-provider",
      coverage: { all: true },
      priority: 1,
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      attribution: [],
      async getVehiclePositions() {
        return { data: [expected], attributions: [], freshness: {} as never };
      },
    };
    const orchestrator = createLiveTransitOrchestrator({
      getIntegrationsByDomain: () => [{ providers: new Map([["live-transit", [provider]]]) }],
      log: { warn: vi.fn() },
    } as never);

    await expect(orchestrator.getVehicles([0, 0, 1, 1])).resolves.toEqual([expected]);
  });
});

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

  it("keeps an observed vehicle when an interpolated position shares its trip", () => {
    const observed = vehicle({ id: "gps:3", tripId: "trip-3", positionKind: "observed" });
    const interpolated = vehicle({ id: "ms:3", tripId: "trip-3", positionKind: "interpolated" });
    expect(preferObservedByTrip([observed, interpolated])).toEqual([observed]);
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
