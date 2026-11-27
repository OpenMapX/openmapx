import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type {
  Departure,
  Facility,
  ServiceAlert,
  TransitRoute,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createTransitOrchestrator } from "../orchestrator.js";

const route: TransitRoute = {
  id: "a:line-1",
  shortName: "1",
  longName: "Line 1",
  mode: "tram",
  operatorName: "",
};
const departure: Departure = {
  tripId: "a:trip",
  route: { id: "a:line-2", shortName: "2", longName: "Line 2", mode: "bus" },
  headsign: "Depot",
  scheduledAt: "2026-10-31T08:00:00Z",
};
const alert: ServiceAlert = {
  id: "a:alert",
  providers: ["a"],
  severity: "warning",
  title: "Lift out of service",
  affectedRouteIds: [],
  affectedStopIds: ["a:stop"],
  activePeriods: [],
};
const facility = { id: "a:lift", type: "elevator", name: "Lift" } as unknown as Facility;

const ok = <T>(data: T) => vi.fn(async () => withAttribution(data, [], freshnessNow()));
const failing = () =>
  vi.fn(async () => {
    throw new Error("upstream down");
  });

function provider(overrides: Partial<TransitProvider>): TransitProvider {
  return {
    id: "a",
    prefix: "a:",
    coverage: { all: true },
    priority: 5,
    role: "regional",
    attribution: [],
    capabilities: {
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
      vehicleJourney: false,
      vehiclePositions: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    healthCheck: async () => ({ status: "up" }),
    ...overrides,
  };
}

function orchestrator(providers: TransitProvider[], coolingDown: string[] = []) {
  const ctx = {
    cache: { withCache: (_key: string, _ttl: number, load: () => Promise<unknown>) => load() },
    providerHealth: {
      isHealthy: async (id: string) => !coolingDown.includes(id),
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    getProviderOrder: () => [],
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit"
        ? [{ manifest: { dataSources: [] }, providers: new Map([["transit", providers]]) }]
        : [],
  } as unknown as IntegrationContext;
  return createTransitOrchestrator(ctx);
}

describe.each([
  ["getStopAlerts", "getAlertsForStop", [alert], "Transit alert source unavailable"],
  ["getFacilities", "getFacilities", [facility], "Transit facility source unavailable"],
] as const)("%s", (lookup, method, answer, unavailable) => {
  it("returns what the provider found", async () => {
    const transit = orchestrator([provider({ [method]: ok(answer) })]);
    expect((await transit[lookup]("a:stop")).data.map((item) => item.id)).toEqual([answer[0].id]);
  });

  it("rejects when the provider fails instead of answering none", async () => {
    const transit = orchestrator([provider({ [method]: failing() })]);
    await expect(transit[lookup]("a:stop")).rejects.toThrow(unavailable);
  });

  it("rejects when the provider that offers the lookup is in cooldown", async () => {
    const lookupFn = ok(answer);
    const transit = orchestrator([provider({ [method]: lookupFn })], ["a"]);
    await expect(transit[lookup]("a:stop")).rejects.toThrow(unavailable);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it.each([
    ["no provider owns the stop id", [provider({ [method]: ok(answer) })], [], "b:stop"],
    ["the provider does not offer the lookup", [provider({})], [], "a:stop"],
    ["only a provider without the lookup is in cooldown", [provider({})], ["a"], "a:stop"],
  ])("answers none when %s", async (_case, providers, coolingDown, stopId) => {
    const transit = orchestrator(providers, coolingDown);
    expect((await transit[lookup](stopId)).data).toEqual([]);
  });
});

describe("getRoutesForStop", () => {
  it("derives lines from departures when the native lookup fails", async () => {
    const transit = orchestrator([
      provider({ getRoutesForStop: failing(), getDepartures: ok([departure]) }),
    ]);
    const routes = await transit.getRoutesForStop("a:stop");
    expect(routes.data.map((r) => r.id)).toEqual(["a:line-2"]);
  });

  it.each([
    [
      "the native lookup and departures fail",
      { getRoutesForStop: failing(), getDepartures: failing() },
    ],
    ["departures, the only source, fail", { getDepartures: failing() }],
    ["the native lookup fails without departures", { getRoutesForStop: failing() }],
  ])("rejects when %s", async (_case, methods) => {
    const transit = orchestrator([provider(methods)]);
    await expect(transit.getRoutesForStop("a:stop")).rejects.toThrow(
      "Transit route source unavailable",
    );
  });

  it("keeps the native empty answer when the departures fallback fails", async () => {
    const transit = orchestrator([
      provider({ getRoutesForStop: ok<TransitRoute[]>([]), getDepartures: failing() }),
    ]);
    expect((await transit.getRoutesForStop("a:stop")).data).toEqual([]);
  });

  it("rejects when the provider is in cooldown, and answers none for an unknown stop", async () => {
    const transit = orchestrator([provider({ getRoutesForStop: ok([route]) })], ["a"]);
    await expect(transit.getRoutesForStop("a:stop")).rejects.toThrow(
      "Transit route source unavailable",
    );
    expect((await transit.getRoutesForStop("b:stop")).data).toEqual([]);
  });
});

it("uses explicitly supported anchored departures and never a current-only board", async () => {
  const current = ok([departure]);
  const anchored = ok([departure]);
  const time = "2026-11-06T20:17:00.000Z";
  const supported = orchestrator([provider({ getDepartures: current, getDeparturesAt: anchored })]);
  await supported.getDepartures("a:stop", 5, time);
  expect(anchored).toHaveBeenCalledWith("a:stop", 5, time);
  expect(current).not.toHaveBeenCalled();
  await expect(
    orchestrator([provider({ getDepartures: current })]).getDepartures("a:stop", 5, time),
  ).rejects.toThrow();
  expect(current).not.toHaveBeenCalled();
});

it("reports health cooldown as unavailable, not unsupported dated departures", async () => {
  const anchored = ok([departure]);
  const source = provider({ getDeparturesAt: anchored });
  await expect(
    orchestrator([source], ["a"]).getDepartures("a:stop", 60, "2026-11-06T20:17:00Z"),
  ).rejects.toThrow(/unavailable/i);
  expect(anchored).not.toHaveBeenCalled();
});

it("resolves only the referenced healthy provider and rejects stale epochs without fallback", async () => {
  const resolveTrip = ok(null);
  const source = provider({
    id: "a",
    prefix: "a:",
    capabilities: { ...provider({}).capabilities, planning: true },
    planningMetadata: { source: "a", instance: "a", datasetEpoch: "E", rentalFormFactors: [] },
    resolveTrip,
  });
  const alternate = provider({ id: "b", prefix: "b:", resolveTrip: ok(null) });
  const reference = {
    datasetEpoch: "E",
    legs: [
      {
        tripId: "a:trip",
        fromStopId: "a:from",
        toStopId: "a:to",
        scheduledDeparture: "2026-11-06T20:18:00.000Z",
        scheduledArrival: "2026-11-06T21:11:00.000Z",
      },
    ],
  };
  await expect(orchestrator([source, alternate]).resolveTrip({ reference })).resolves.toMatchObject(
    { data: null },
  );
  expect(resolveTrip).toHaveBeenCalledTimes(1);
  expect(alternate.resolveTrip).not.toHaveBeenCalled();
  await expect(
    orchestrator([source]).resolveTrip({ reference: { ...reference, datasetEpoch: "stale" } }),
  ).rejects.toThrow(/epoch/i);
  await expect(orchestrator([source], ["a"]).resolveTrip({ reference })).rejects.toThrow();
  expect(resolveTrip).toHaveBeenCalledTimes(1);
});

describe("getRouteStops through a departure's journey", () => {
  const journey: VehicleJourney = {
    id: "a:trip",
    name: "2",
    provider: "a",
    stops: [
      { stopId: "a:start", name: "Start", lat: 47, lng: 8, platform: "1" },
      { stopId: "a:unplaced", name: "Unplaced" },
      { stopId: "a:end", name: "End", lat: 47.1, lng: 8.1 },
    ],
  };

  it("keeps an unplaced journey stop in order and numbers every stop from 1", async () => {
    const transit = orchestrator([
      provider({
        getRouteStops: ok([]),
        getDepartures: ok([departure]),
        getVehicleJourney: ok(journey),
      }),
    ]);
    const { data } = await transit.getRouteStops("a:line-2", "a:stop");
    expect(data).toMatchObject([
      { id: "a:start", name: "Start", lat: 47, lng: 8, platformCode: "1", sequence: 1 },
      { id: "a:unplaced", name: "Unplaced", sequence: 2 },
      { id: "a:end", name: "End", lat: 47.1, lng: 8.1, sequence: 3 },
    ]);
    expect(data[1]).not.toHaveProperty("lat");
    expect(data[1]).not.toHaveProperty("lng");
  });

  it("answers none without a hint stop to find a departure", async () => {
    const getDepartures = ok([departure]);
    const transit = orchestrator([
      provider({ getRouteStops: ok([]), getDepartures, getVehicleJourney: ok(journey) }),
    ]);
    expect((await transit.getRouteStops("a:line-2")).data).toEqual([]);
    expect(getDepartures).not.toHaveBeenCalled();
  });
});
