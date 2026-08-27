import type { TransitCapabilities, TransitProvider } from "@openmapx/integration-framework";
import { assertTransitProviderContract } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";

/**
 * These tests verify that every capability flag declared by transit-motis
 * providers has a corresponding method present on the provider object.
 * They use `assertTransitProviderContract` — the runtime assertion helper
 * that the integration loader can call to catch contract violations early.
 */

const allFalse: TransitCapabilities = {
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

// Stub methods — real logic is not exercised here; we only check presence.
const noop = async (): Promise<never> => {
  throw new Error("stub");
};

describe("transit-motis provider contract", () => {
  it("cloud provider (transit-motis-transitous) satisfies its declared capabilities", () => {
    const cloudCapabilities: TransitCapabilities = {
      ...allFalse,
      stops: { ...allFalse.stops, lookup: true },
      departures: true,
      arrivals: true,
      vehicleJourney: true,
    };

    const cloudProvider: TransitProvider = {
      id: "transit-motis-transitous",
      prefix: "mo:",
      coverage: { all: true },
      priority: 7,
      role: "fallback",
      attribution: [],
      capabilities: cloudCapabilities,
      getStop: noop,
      getDepartures: noop,
      getArrivals: noop,
      getVehicleJourney: noop,
    };

    expect(() => assertTransitProviderContract(cloudProvider)).not.toThrow();
  });

  it("local provider (transit-motis-local) satisfies its declared capabilities", () => {
    const localCapabilities: TransitCapabilities = {
      ...allFalse,
      stops: {
        ...allFalse.stops,
        lookup: true,
        nearby: true,
        bbox: true,
        search: true,
        platforms: true,
        timetable: true,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: true,
      vehicleJourney: true,
    };

    const localProvider: TransitProvider = {
      id: "transit-motis-local",
      prefix: "ms:",
      coverage: { all: true },
      priority: 1,
      role: "baseline",
      attribution: [],
      capabilities: localCapabilities,
      getStop: noop,
      getStopsNearby: noop,
      getStopsInBbox: noop,
      searchStopsByName: noop,
      getStopPlatforms: noop,
      getStopTimetable: noop,
      getDepartures: noop,
      getArrivals: noop,
      getRoute: noop,
      getRoutesForStop: noop,
      getRouteStops: noop,
      getLegGeometry: noop,
      planTrip: noop,
      getVehicleJourney: noop,
    };

    expect(() => assertTransitProviderContract(localProvider)).not.toThrow();
  });

  it("detects a provider that declares a capability without its required method", () => {
    const brokenProvider: TransitProvider = {
      id: "transit-motis-broken",
      prefix: "ms:",
      coverage: { all: true },
      priority: 99,
      role: "baseline",
      attribution: [],
      capabilities: {
        ...allFalse,
        departures: true,
      },
    };

    expect(() => assertTransitProviderContract(brokenProvider)).toThrow(/getDepartures/);
  });
});
