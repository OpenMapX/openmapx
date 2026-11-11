import {
  type IntegrationContext,
  ProviderInputError,
  type TransitProvider,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createTransitOrchestrator } from "../orchestrator.js";
import { createPlaceTransit } from "../place-transit.js";

const ATTR = [{ sourceId: "feed", name: "Feed" }];
const place = { lat: 50.775, lng: 6.084, name: "Aachen Central" };
const stop: TransitStop = {
  id: "tst:central",
  provider: "tst",
  name: "Aachen Central",
  lat: 50.775,
  lng: 6.084,
  modes: ["rail"],
};

/**
 * A provider whose stop search still works while every lookup by stop id now
 * answers "unknown identifier", as when its departures endpoint breaks.
 */
function brokenLookups(): TransitProvider {
  const unknown = async () => {
    throw new ProviderInputError("Unknown stop identifier");
  };
  return {
    id: "tst",
    prefix: "tst:",
    coverage: { all: true },
    priority: 5,
    role: "regional",
    attribution: ATTR,
    capabilities: {
      stops: {
        lookup: false,
        nearby: false,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: true, stops: false, geometry: false },
      planning: false,
      vehicleJourney: false,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      facilities: true,
    },
    healthCheck: async () => ({ healthy: true }),
    searchStopsByName: vi.fn(async () => withAttribution([stop], ATTR, freshnessNow())),
    getDepartures: vi.fn(unknown),
    getArrivals: vi.fn(unknown),
    getAlertsForStop: vi.fn(unknown),
    getRoutesForStop: vi.fn(unknown),
    getFacilities: vi.fn(unknown),
  } as unknown as TransitProvider;
}

function fixture() {
  const recordFailure = vi.fn(async () => {});
  const provider = brokenLookups();
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
    providerHealth: {
      isHealthy: async () => true,
      recordSuccess: async () => {},
      recordFailure,
      getSnapshot: vi.fn(),
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit"
        ? [
            {
              manifest: { dataSources: [{ sourceId: "feed" }] },
              providers: new Map([["transit", [provider]]]),
            },
          ]
        : [],
  } as unknown as IntegrationContext;
  const orchestrator = createTransitOrchestrator(ctx);
  return { orchestrator, places: createPlaceTransit(ctx, orchestrator), recordFailure };
}

const outcomes = (spy: ReturnType<typeof vi.fn>) =>
  (spy.mock.calls as unknown as unknown[][]).map((call) => [call[0], call[2]]);

describe("identifier origin and provider health", () => {
  it("keeps an unknown identifier from the request as uncounted input", async () => {
    const { orchestrator, recordFailure } = fixture();

    await orchestrator.getDepartures("tst:bogus", 30).catch(() => undefined);
    await orchestrator.getArrivals("tst:bogus", 30).catch(() => undefined);
    await orchestrator.getStopAlerts("tst:bogus").catch(() => undefined);
    await orchestrator.getFacilities("tst:bogus").catch(() => undefined);

    expect(outcomes(recordFailure)).toEqual([
      ["tst", "input"],
      ["tst", "input"],
      ["tst", "input"],
      ["tst", "input"],
    ]);
  });

  it.each([
    [
      "getMergedDepartures",
      (p: ReturnType<typeof fixture>["places"]) => p.getMergedDepartures(place, 60),
    ],
    [
      "getMergedArrivals",
      (p: ReturnType<typeof fixture>["places"]) => p.getMergedArrivals(place, 60),
    ],
    ["getMergedAlerts", (p: ReturnType<typeof fixture>["places"]) => p.getMergedAlerts(place)],
    ["getMergedRoutes", (p: ReturnType<typeof fixture>["places"]) => p.getMergedRoutes(place)],
    [
      "getMergedFacilities",
      (p: ReturnType<typeof fixture>["places"]) => p.getMergedFacilities(place),
    ],
  ])("counts an unknown identifier the %s fan-out found itself", async (_name, call) => {
    const { places, recordFailure } = fixture();

    await call(places).catch(() => undefined);

    const recorded = outcomes(recordFailure);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every(([, outcome]) => outcome === "connection")).toBe(true);
  });
});
