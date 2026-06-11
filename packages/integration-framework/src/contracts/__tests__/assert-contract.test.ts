import { describe, expect, it } from "vitest";
import {
  assertProviderSatisfiesContract,
  assertRealtimeProviderContract,
  assertTransitProviderContract,
} from "../assert-contract.js";
import type { TransitCapabilities } from "../transit-provider.js";

const allFalseTransitCapabilities: TransitCapabilities = {
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

describe("assertProviderSatisfiesContract", () => {
  it("passes when all capabilities are false and no methods are present", () => {
    expect(() =>
      assertProviderSatisfiesContract(
        { id: "minimal" },
        allFalseTransitCapabilities as unknown as Record<string, unknown>,
        [["departures", "getDepartures"]],
        "minimal",
      ),
    ).not.toThrow();
  });

  it("passes when a capability is true and the required method is present", () => {
    expect(() =>
      assertProviderSatisfiesContract(
        { id: "ok", getDepartures: () => {} },
        { departures: true },
        [["departures", "getDepartures"]],
        "ok",
      ),
    ).not.toThrow();
  });

  it("throws naming the missing method when a capability is declared true but the method is absent", () => {
    expect(() =>
      assertProviderSatisfiesContract(
        { id: "broken" },
        { departures: true },
        [["departures", "getDepartures"]],
        "broken",
      ),
    ).toThrow(/method "getDepartures"/);
  });

  it("throws listing all missing methods in a single error", () => {
    expect(() =>
      assertProviderSatisfiesContract(
        { id: "multi-missing" },
        { departures: true, arrivals: true },
        [
          ["departures", "getDepartures"],
          ["arrivals", "getArrivals"],
        ],
        "multi-missing",
      ),
    ).toThrow(/getDepartures[\s\S]*getArrivals/);
  });

  it("resolves nested capability paths (e.g. stops.lookup)", () => {
    expect(() =>
      assertProviderSatisfiesContract(
        { id: "nested-missing" },
        { stops: { lookup: true } },
        [["stops.lookup", "getStop"]],
        "nested-missing",
      ),
    ).toThrow(/method "getStop"/);

    expect(() =>
      assertProviderSatisfiesContract(
        { id: "nested-ok", getStop: () => {} },
        { stops: { lookup: true } },
        [["stops.lookup", "getStop"]],
        "nested-ok",
      ),
    ).not.toThrow();
  });

  it("passes when capabilities object is empty", () => {
    expect(() =>
      assertProviderSatisfiesContract({ id: "empty" }, {}, [["departures", "getDepartures"]]),
    ).not.toThrow();
  });
});

describe("assertTransitProviderContract", () => {
  it("passes for a complete transit provider declaring departures: true with getDepartures", () => {
    const provider = {
      id: "transit-ok",
      prefix: "t:",
      coverage: { all: true as const },
      priority: 1,
      attribution: [],
      capabilities: {
        ...allFalseTransitCapabilities,
        departures: true,
      },
      getDepartures: async () => ({ data: [], attributions: [], freshness: {} as never }),
    };
    expect(() => assertTransitProviderContract(provider)).not.toThrow();
  });

  it("throws when departures: true but getDepartures is absent", () => {
    const provider = {
      id: "transit-broken",
      prefix: "t:",
      coverage: { all: true as const },
      priority: 1,
      attribution: [],
      capabilities: {
        ...allFalseTransitCapabilities,
        departures: true,
      },
    };
    expect(() => assertTransitProviderContract(provider)).toThrow(
      /provider: transit-broken[\s\S]*getDepartures/,
    );
  });
});

describe("assertRealtimeProviderContract", () => {
  it("passes for a complete realtime provider declaring vehiclePositions: true", () => {
    const provider = {
      id: "rt-ok",
      coverage: { all: true as const },
      priority: 1,
      attribution: [],
      capabilities: {
        vehiclePositions: true,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      getVehiclePositions: async () => ({ data: [], attributions: [], freshness: {} as never }),
    };
    expect(() => assertRealtimeProviderContract(provider)).not.toThrow();
  });

  it("throws when tripUpdates: true but getTripUpdate is absent", () => {
    const provider = {
      id: "rt-broken",
      coverage: { all: true as const },
      priority: 1,
      attribution: [],
      capabilities: {
        vehiclePositions: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: true,
      },
    };
    expect(() => assertRealtimeProviderContract(provider)).toThrow(
      /provider: rt-broken[\s\S]*getTripUpdate/,
    );
  });
});
