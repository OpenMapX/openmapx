import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import { describe, expect, it } from "vitest";
import type { RealtimeProvider, TransitCapabilities, TransitProvider } from "../index.js";

// These tests are compile-time assertions: the goal is that `pnpm check-types`
// catches any breakage in the canonical TransitProvider / RealtimeProvider
// shapes. Runtime assertions are intentionally trivial.

const noAttribution: Attribution[] = [];

const allFalseCapabilities: TransitCapabilities = {
  stops: {
    lookup: false,
    nearby: false,
    bbox: false,
    search: false,
    infrastructure: false,
    platforms: false,
    timetable: false,
  },
  departures: false,
  arrivals: false,
  routes: { lookup: false, forStop: false, stops: false, geometry: false },
  planning: false,
  vehiclePositions: false,
  vehicleJourney: false,
  alerts: { byStop: false, byRoute: false, byBbox: false },
  facilities: false,
};

describe("TransitProvider contract", () => {
  it("accepts a minimal provider with all capabilities false and no methods", () => {
    const provider: TransitProvider = {
      id: "minimal",
      prefix: "min:",
      coverage: { all: true },
      priority: 1,
      capabilities: allFalseCapabilities,
      attribution: noAttribution,
    };
    expect(provider.id).toBe("minimal");
  });

  it("accepts a provider with one capability enabled and the matching method defined", () => {
    const provider: TransitProvider = {
      id: "with-stop-lookup",
      prefix: "wsl:",
      coverage: { bbox: [-180, -90, 180, 90] },
      priority: 2,
      capabilities: {
        ...allFalseCapabilities,
        stops: { ...allFalseCapabilities.stops, lookup: true },
      },
      attribution: noAttribution,
      async getStop(_id: string): Promise<MobilityResult<null>> {
        return {
          data: null,
          attributions: [],
          freshness: {
            fetchedAt: new Date().toISOString(),
            hasRealtimeData: false,
            isStale: false,
          },
        };
      },
    };
    expect(provider.capabilities.stops.lookup).toBe(true);
  });

  it("accepts both coverage discriminants: bbox and all", () => {
    const bboxProvider: TransitProvider = {
      id: "bbox-cov",
      prefix: "b:",
      coverage: { bbox: [0, 0, 1, 1] },
      priority: 1,
      capabilities: allFalseCapabilities,
      attribution: noAttribution,
    };
    const globalProvider: TransitProvider = {
      id: "global-cov",
      prefix: "g:",
      coverage: { all: true },
      priority: 1,
      capabilities: allFalseCapabilities,
      attribution: noAttribution,
    };
    expect("bbox" in bboxProvider.coverage).toBe(true);
    expect("all" in globalProvider.coverage).toBe(true);
  });
});

describe("RealtimeProvider contract", () => {
  it("accepts a provider with vehiclePositions: true and getVehiclePositions defined", () => {
    const provider: RealtimeProvider = {
      id: "rt-vehicles",
      coverage: { bbox: [-180, -90, 180, 90] },
      priority: 5,
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      attribution: noAttribution,
      async getVehiclePositions(_bbox): Promise<MobilityResult<[]>> {
        return {
          data: [],
          attributions: [],
          freshness: {
            fetchedAt: new Date().toISOString(),
            hasRealtimeData: true,
            isStale: false,
          },
        };
      },
    };
    expect(provider.capabilities.vehiclePositions).toBe(true);
  });
});
