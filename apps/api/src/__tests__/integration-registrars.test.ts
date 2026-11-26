import type { IntegrationManifest, ProviderDomain } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { createProviderRegistrars } from "../integration-registrars";

function manifest(id: string, sourceIds: string[] = []): IntegrationManifest {
  return {
    id,
    dataSources: sourceIds.map((sourceId) => ({ sourceId })),
  } as unknown as IntegrationManifest;
}

function registrarsFor(integrationId: string, providers = new Map<string, unknown[]>()) {
  const bound: Array<[ProviderDomain, object]> = [];
  const bind = <T extends object>(domain: ProviderDomain, provider: T): T => {
    bound.push([domain, provider]);
    return provider;
  };
  return {
    providers,
    bound,
    registrars: createProviderRegistrars({
      integrationId,
      manifest: manifest(integrationId),
      providers,
      bind,
    }),
  };
}

const routing = (id: string) => ({
  id,
  supportedModes: ["driving" as const],
  getRoute: async () => ({}) as never,
});

describe("createProviderRegistrars", () => {
  it("stores the bound provider under its domain", () => {
    const { registrars, providers, bound } = registrarsFor("demo");
    const provider = routing("x");
    registrars.registerRoutingProvider(provider);
    expect(bound).toEqual([["routing", provider]]);
    expect(providers.get("routing")).toEqual([provider]);
  });

  it("refuses a provider that misses a required member", () => {
    const { registrars, providers } = registrarsFor("demo");
    expect(() => registrars.registerWeatherProvider({ id: "x", priority: 1 } as never)).toThrow(
      "Integration demo: weather provider is missing getCurrentWeather",
    );
    expect(providers.has("weather")).toBe(false);
  });

  it("refuses a duplicate provider id inside one integration and domain", () => {
    const { registrars, providers } = registrarsFor("demo");
    registrars.registerRoutingProvider(routing("x"));
    expect(() => registrars.registerRoutingProvider(routing("x"))).toThrow(
      "Integration demo: routing provider x is registered twice",
    );
    expect(providers.get("routing")).toHaveLength(1);
    registrars.registerRoutingProvider(routing("y"));
    expect(providers.get("routing")).toHaveLength(2);
  });

  it("lets the same id stand in another domain or another integration", () => {
    const { registrars } = registrarsFor("demo");
    registrars.registerRoutingProvider(routing("x"));
    expect(() =>
      registrars.registerSearchSuggestionProvider({
        id: "x",
        searchSuggestions: async () => ({}) as never,
      }),
    ).not.toThrow();
    const other = registrarsFor("other");
    expect(() => other.registrars.registerRoutingProvider(routing("x"))).not.toThrow();
  });

  it("keys knowledge providers by name and leaves geocoding providers unkeyed", () => {
    const { registrars, providers } = registrarsFor("demo");
    const knowledge = { name: "wiki", lookup: async () => null };
    registrars.registerKnowledgeProvider(knowledge);
    expect(() => registrars.registerKnowledgeProvider({ ...knowledge })).toThrow(
      "Integration demo: knowledge provider wiki is registered twice",
    );
    const geocoder = {
      geocode: async () => [],
      autocomplete: async () => [],
      reverseGeocode: async () => null,
    };
    registrars.registerGeocodingProvider(geocoder);
    registrars.registerGeocodingProvider({ ...geocoder });
    expect(providers.get("geocoding")).toHaveLength(2);
  });

  it("runs the transit capability contract at registration", () => {
    const { registrars, providers } = registrarsFor("demo");
    expect(() =>
      registrars.registerTransitProvider({
        id: "t",
        prefix: "t",
        coverage: { all: true },
        priority: 1,
        role: "primary",
        capabilities: { departures: true },
        attribution: [],
      } as never),
    ).toThrow(/capability "departures" requires method "getDepartures"/);
    expect(providers.has("transit")).toBe(false);
  });

  it("runs the realtime capability contract at registration", () => {
    const { registrars, providers } = registrarsFor("demo");
    expect(() =>
      registrars.registerRealtimeProvider({
        id: "rt",
        coverage: { all: true },
        priority: 1,
        capabilities: { vehiclePositions: true },
        attribution: [],
      } as never),
    ).toThrow(/capability "vehiclePositions" requires method "getVehiclePositions"/);
    expect(providers.has("live-transit")).toBe(false);
  });

  it("runs the ride capability contract at registration", () => {
    const { registrars, providers } = registrarsFor("demo");
    expect(() =>
      registrars.registerRideProvider({
        id: "ride",
        meta: {},
        capabilities: { quote: false, booking: false, tracking: false },
        permitsComparison: false,
        attribution: [],
        getAvailability: async () => ({}),
        createHandoff: async () => ({}),
      } as never),
    ).toThrow('Ride provider "ride" must declare the deepLink capability');
    expect(providers.has("ride-hailing")).toBe(false);
  });

  it("accepts required members that are getters or inherited from a class", () => {
    const { registrars, providers } = registrarsFor("demo");
    class Base {
      get id() {
        return "inherited";
      }
      get supportedModes() {
        return ["driving" as const];
      }
      async getRoute() {
        return {} as never;
      }
    }
    class Derived extends Base {}
    const ownGetters = {
      get id() {
        return "own";
      },
      get supportedModes() {
        return ["driving" as const];
      },
      getRoute: async () => ({}) as never,
    };
    registrars.registerRoutingProvider(new Derived());
    registrars.registerRoutingProvider(ownGetters);
    expect(providers.get("routing")).toHaveLength(2);
  });

  it("refuses a data source whose id cannot be a place id scheme", () => {
    const { registrars } = registrarsFor("demo");
    expect(() =>
      registrars.registerMobilityDataSource({
        id: "Bad_Id",
        meta: {},
        attribution: [],
        getFilters: async () => [],
        search: async () => ({}),
        getDetail: async () => ({}),
      } as never),
    ).toThrow(/Data source id "Bad_Id" must start with a letter/);
  });
});
