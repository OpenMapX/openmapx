import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type {
  Departure,
  Facility,
  ServiceAlert,
  TransitRoute,
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
    },
    healthCheck: async () => ({ healthy: true }),
    ...overrides,
  };
}

function orchestrator(providers: TransitProvider[], coolingDown: string[] = []) {
  const ctx = {
    providerHealth: {
      isHealthy: async (id: string) => !coolingDown.includes(id),
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => new Set<string>(),
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
