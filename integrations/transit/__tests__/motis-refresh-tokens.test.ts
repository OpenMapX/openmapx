import type {
  IntegrationContext,
  TransitProvider,
  TripRefreshRequest,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { createMotisInstance } from "@openmapx/mobility-core/motis-client";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { afterEach, describe, expect, it, vi } from "vitest";
import trip from "../../transit-motis/__tests__/fixtures/re1-26839-transitous-trip.json";
import {
  planTrip as planWithMotis,
  refreshTrip as refreshWithMotis,
} from "../../transit-motis/adapter";
import { setup } from "../index.js";

afterEach(() => vi.unstubAllEnvs());

type Handler = (
  request: { body?: unknown; query?: Record<string, string>; params?: Record<string, string> },
  reply: Reply,
) => Promise<void>;
interface Reply {
  statusCode: number;
  body?: unknown;
  header(): Reply;
  status(code: number): Reply;
  send(value: unknown): Reply;
}

const QUERY = { from_lat: "50.7678", from_lng: "6.0915", to_lat: "51.5136", to_lng: "7.4653" };

function capabilities(refresh: boolean, planning = true): TransitProvider["capabilities"] {
  return {
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
    planning,
    planningFeatures: {
      maxTransfers: false,
      transferBuffer: false,
      wheelchairRequired: false,
      bikeTransport: false,
      elevation: false,
      rentalFilters: false,
      detailedTransfers: false,
      paging: false,
      refresh,
    },
    vehicleJourney: false,
    vehiclePositions: false,
    alerts: { byStop: false, byRoute: false, byBbox: false },
    facilities: false,
  };
}

/**
 * The built-in local MOTIS planner as it answers through the real adapter:
 * the plan names the provider (`transit-motis-local`), every itinerary names
 * the MOTIS instance (`ms`). `trip` answers decide each refresh.
 */
function motisPlanner(initialEpoch: string | undefined, trips: Array<"gone" | "ok">) {
  let epoch = initialEpoch;
  const instance = createMotisInstance({
    baseUrl: "http://motis.test",
    prefix: "ms:",
    provider: "ms",
  });
  const refreshCalls: TripRefreshRequest[] = [];
  instance.client.setConfig({
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/plan"))
        return Response.json({
          from: { name: "Aachen, Hbf", lat: 50.7678, lon: 6.0915 },
          to: { name: "Dortmund, Hbf", lat: 51.5136, lon: 7.4653 },
          direct: [],
          itineraries: [trip],
        });
      return trips.shift() === "gone"
        ? Response.json({ error: "no legs reconstructed" }, { status: 400 })
        : Response.json(trip);
    },
  });
  const provider: TransitProvider = {
    id: "transit-motis-local",
    prefix: "ms:",
    priority: 1,
    role: "baseline",
    coverage: { all: true },
    attribution: [],
    capabilities: capabilities(true),
    healthCheck: async () => ({ status: "up" }),
    async planTrip(params) {
      const plan = await planWithMotis(
        instance,
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        "2026-11-06",
        "21:00",
        false,
        1,
        { datasetEpoch: epoch },
      );
      return withAttribution(plan ? [plan] : [], [], freshnessNow());
    },
    async refreshTrip(params) {
      refreshCalls.push(params);
      return withAttribution(
        await refreshWithMotis(instance, params.itineraryId, { datasetEpoch: params.datasetEpoch }),
        [],
        freshnessNow(),
      );
    },
  };
  return {
    provider,
    refreshCalls,
    setEpoch: (next: string | undefined) => {
      epoch = next;
    },
  };
}

function harness(
  integrations: Array<{ id: string; providers: TransitProvider[] }>,
  order: string[] = [],
) {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-motis-refresh-secret");
  const handlers = new Map<string, Handler>();
  const cache = new Map<string, unknown>();
  const ctx = {
    cache: {
      get: async (key: string) => cache.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
      del: async (key: string) => {
        cache.delete(key);
      },
      withCache: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
    },
    providerHealth: {
      isHealthy: async () => true,
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    getProviderOrder: () => order,
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit"
        ? integrations.map(({ id, providers }) => ({
            id,
            manifest: { dataSources: [] },
            providers: new Map([["transit", providers]]),
          }))
        : [],
    registerSearchSuggestionProvider: () => {},
    registerRoute: (method: string, path: string, handler: Handler) =>
      handlers.set(`${method} ${path}`, handler),
  } as unknown as IntegrationContext;
  setup(ctx);
  async function call(method: string, path: string, request: Parameters<Handler>[0]) {
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) throw new Error(`Missing ${method} ${path}`);
    const reply: Reply = {
      statusCode: 200,
      header() {
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(value) {
        this.body = value;
        return this;
      },
    };
    await handler({ query: {}, params: {}, ...request }, reply);
    return reply;
  }
  const plan = async () => {
    const reply = await call("GET", "/plan", { query: QUERY });
    expect(reply.statusCode).toBe(200);
    return (reply.body as { data: TripPlan }).data;
  };
  const refresh = async (token: string | undefined) => {
    const reply = await call("POST", "/plan/refresh", { body: { token } });
    expect(reply.statusCode).toBe(200);
    return (reply.body as { data: { itinerary: TripItinerary; fallbackOccurred: boolean } }).data;
  };
  return { plan, refresh };
}

describe("refresh tokens for the built-in MOTIS planner", () => {
  it.each([
    ["epoch-1", "issues"],
    [undefined, "issues no"],
  ])("with dataset epoch %s, /plan and a replan both %s token", async (epoch, _outcome) => {
    const motis = motisPlanner("epoch-1", ["gone"]);
    const h = harness([{ id: "transit-motis", providers: [motis.provider] }]);
    const planned = await h.plan();
    // The shapes that matter: the plan names the provider, the itinerary the instance.
    expect(planned.source).toBe("transit-motis-local");
    expect(planned.itineraries[0]?.source).toBe("ms");
    const first = planned.itineraries[0]?.refreshToken;
    // From here on the planner answers /plan and the replan alike.
    motis.setEpoch(epoch);
    const planToken = (await h.plan()).itineraries[0]?.refreshToken;
    const replanned = await h.refresh(first);
    expect(replanned.fallbackOccurred).toBe(true);
    expect(typeof planToken).toBe(epoch ? "string" : "undefined");
    expect(typeof replanned.itinerary.refreshToken).toBe(typeof planToken);
  });

  it("issues the next token after a successful refresh under the same rule as /plan", async () => {
    const motis = motisPlanner("epoch-1", ["gone", "ok", "ok"]);
    const h = harness([{ id: "transit-motis", providers: [motis.provider] }]);
    const planned = await h.plan();
    const replanned = await h.refresh(planned.itineraries[0]?.refreshToken);
    expect(replanned.fallbackOccurred).toBe(true);
    const refreshed = await h.refresh(replanned.itinerary.refreshToken);
    expect(refreshed.fallbackOccurred).toBe(false);
    expect(refreshed.itinerary.refreshToken).toEqual(expect.any(String));
    await h.refresh(refreshed.itinerary.refreshToken);
    expect(motis.refreshCalls.map((call) => call.datasetEpoch)).toEqual([
      "epoch-1",
      "epoch-1",
      "epoch-1",
    ]);
  });
});

it("never lets another integration's planner with the same provider id redeem a token", async () => {
  const issuing = motisPlanner("epoch-1", ["ok"]);
  const otherRefresh = vi.fn(async () => withAttribution(null, [], freshnessNow()));
  const other: TransitProvider = {
    ...issuing.provider,
    capabilities: capabilities(true, false),
    planTrip: undefined,
    refreshTrip: otherRefresh,
  };
  // The other integration is served first, so a lookup by provider id alone finds it.
  const h = harness(
    [
      { id: "transit-motis", providers: [issuing.provider] },
      { id: "transit-impostor", providers: [other] },
    ],
    ["transit-impostor", "transit-motis"],
  );
  const planned = await h.plan();
  const refreshed = await h.refresh(planned.itineraries[0]?.refreshToken);
  expect(refreshed.fallbackOccurred).toBe(false);
  expect(issuing.refreshCalls).toHaveLength(1);
  expect(otherRefresh).not.toHaveBeenCalled();
});
