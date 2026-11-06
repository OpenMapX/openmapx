import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TransitTripResolveRequest, TripPlan } from "@openmapx/mobility-core/transit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

afterEach(() => vi.unstubAllEnvs());
interface Reply {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
  header(name: string, value: string): Reply;
  status(code: number): Reply;
  send(value: unknown): Reply;
}
type Handler = (
  request: { body: unknown; query: Record<string, string>; params: Record<string, string> },
  reply: Reply,
) => Promise<void>;
const input: TransitTripResolveRequest = {
  reference: {
    datasetEpoch: "E",
    legs: [
      {
        tripId: "ms:trip",
        fromStopId: "ms:a",
        toStopId: "ms:b",
        scheduledDeparture: "2026-11-06T20:18:00.000Z",
        scheduledArrival: "2026-11-06T21:11:00.000Z",
      },
    ],
  },
};
function fixture(healthy = true, cacheResolution = false) {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-resolved-trip-secret");
  const from = { name: "Provider Aachen", stopId: "ms:a", lat: 50.768, lng: 6.091 };
  const to = { name: "Provider Koeln", stopId: "ms:b", lat: 50.943, lng: 6.959 };
  const plan: TripPlan = {
    from,
    to,
    source: "transit-motis-local",
    instance: "ms",
    provider: "ms",
    datasetEpoch: "E",
    itineraries: [
      {
        id: "native-id",
        source: "ms",
        instance: "ms",
        datasetEpoch: "E",
        startTime: input.reference.legs[0].scheduledDeparture,
        endTime: input.reference.legs[0].scheduledArrival,
        duration: 3180,
        transfers: 0,
        walkDistance: 0,
        fare: { source: "provider", transfers: [] },
        legs: [
          {
            mode: "rail",
            from,
            to,
            tripId: "ms:trip",
            startTime: input.reference.legs[0].scheduledDeparture,
            endTime: input.reference.legs[0].scheduledArrival,
            scheduledStartTime: input.reference.legs[0].scheduledDeparture,
            scheduledEndTime: input.reference.legs[0].scheduledArrival,
            geometry: {
              type: "LineString",
              coordinates: [
                [6.091, 50.768],
                [6.959, 50.943],
              ],
            },
          },
        ],
      },
    ],
  };
  const resolved = vi.fn(async () => withAttribution<TripPlan | null>(plan, [], freshnessNow()));
  const planned = vi.fn(async () => withAttribution([], [], freshnessNow()));
  const provider: TransitProvider = {
    id: "transit-motis-local",
    prefix: "ms:",
    priority: 1,
    role: "baseline",
    coverage: { all: true },
    attribution: [],
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: true,
        search: true,
        infrastructure: false,
        platforms: true,
        timetable: true,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: true,
      vehicleJourney: true,
    },
    planningMetadata: {
      source: "transit-motis-local",
      instance: "ms",
      datasetEpoch: "E",
      rentalFormFactors: [],
    },
    healthCheck: async () => ({ healthy: true }),
    resolveTrip: resolved,
    planTrip: planned,
  };
  const handlers = new Map<string, Handler>(),
    cache = new Map<string, unknown>();
  const disallowed = new Set<string>();
  const ctx = {
    cache: {
      get: async (key: string) => cache.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
      del: async (key: string) => {
        cache.delete(key);
      },
      withCache: async (key: string, _ttl: number, load: () => Promise<unknown>) => {
        if (cacheResolution && cache.has(key)) return cache.get(key);
        const value = await load();
        if (cacheResolution) cache.set(key, value);
        return value;
      },
    },
    providerHealth: {
      isHealthy: async () => healthy,
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => disallowed,
    getIntegrationsByDomain: () => [
      {
        manifest: { dataSources: [{ sourceId: "test-source" }] },
        providers: new Map([["transit", [provider]]]),
      },
    ],
    registerSearchSuggestionProvider: () => {},
    registerRoute: (method: string, path: string, handler: Handler) =>
      handlers.set(`${method} ${path}`, handler),
  } as unknown as IntegrationContext;
  setup(ctx);
  async function request(path: string, body: unknown) {
    const handler = handlers.get(`POST ${path}`);
    if (!handler) throw new Error(`Missing POST ${path}`);
    const reply: Reply = {
      statusCode: 200,
      headers: {},
      header(name, value) {
        this.headers[name] = value;
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
    await handler({ body, query: {}, params: {} }, reply);
    return reply;
  }
  return {
    request,
    resolved,
    planned,
    plan,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
    disallowed,
  };
}

describe("exact provider-reference plan route", () => {
  it("delivers normal provider data and refreshes only the same reference", async () => {
    const f = fixture();
    const reply = await f.request("/plan/resolve", input);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(JSON.stringify(reply.body)) as MobilityEnvelope<TripPlan>;
    const itinerary = body.data.itineraries[0];
    expect(itinerary).toMatchObject({
      id: "native-id",
      fare: { source: "provider", transfers: [] },
      legs: [{ from: { name: "Provider Aachen" }, tripId: "ms:trip" }],
    });
    expect(itinerary.refreshToken).toEqual(expect.any(String));
    f.resolved.mockResolvedValue(withAttribution(null, [], freshnessNow()));
    const refresh = await f.request("/plan/refresh", { token: itinerary.refreshToken });
    expect(refresh.statusCode).toBe(409);
    expect(f.resolved).toHaveBeenCalledTimes(2);
    expect(f.planned).not.toHaveBeenCalled();
  });

  it.each(["coordinates", "mixed-prefix", "too-many", "invalid-time"])(
    "rejects %s before provider access",
    async (kind) => {
      const f = fixture();
      const body = structuredClone(input);
      if (kind === "coordinates") Object.assign(body.reference.legs[0], { fromLat: 0 });
      if (kind === "mixed-prefix") body.reference.legs[0].toStopId = "mo:b";
      if (kind === "too-many")
        body.reference.legs = Array.from({ length: 9 }, () => ({ ...input.reference.legs[0] }));
      if (kind === "invalid-time")
        body.reference.legs[0].scheduledDeparture = "2026-02-30T20:18:00Z";
      expect((await f.request("/plan/resolve", body)).statusCode).toBe(400);
      expect(f.resolved).not.toHaveBeenCalled();
    },
  );

  it("rejects an epoch change and an unhealthy source without trying another plan", async () => {
    const f = fixture();
    expect(
      (
        await f.request("/plan/resolve", {
          ...input,
          reference: { ...input.reference, datasetEpoch: "stale" },
        })
      ).statusCode,
    ).toBe(409);
    expect(f.resolved).not.toHaveBeenCalled();
    const unavailable = fixture(false);
    expect((await unavailable.request("/plan/resolve", input)).statusCode).toBe(503);
    expect(unavailable.resolved).not.toHaveBeenCalled();
    expect(unavailable.planned).not.toHaveBeenCalled();
  });
});

it("caches acquisition briefly without sharing refresh handles or bypassing current health", async () => {
  const f = fixture(true, true);
  const a = await f.request("/plan/resolve", input);
  const aToken = (a.body as MobilityEnvelope<TripPlan>).data.itineraries[0].refreshToken;
  const b = await f.request("/plan/resolve", input);
  const bToken = (b.body as MobilityEnvelope<TripPlan>).data.itineraries[0].refreshToken;
  expect(f.resolved).toHaveBeenCalledTimes(1);
  expect(aToken).toEqual(expect.any(String));
  expect(bToken).not.toBe(aToken);
  expect((a.body as MobilityEnvelope<TripPlan>).data.itineraries[0].refreshToken).toBe(aToken);
  f.setHealthy(false);
  expect((await f.request("/plan/resolve", input)).statusCode).toBe(503);
  expect(f.resolved).toHaveBeenCalledTimes(1);
  f.setHealthy(true);
  f.disallowed.add("test-source");
  expect((await f.request("/plan/resolve", input)).statusCode).toBe(503);
  expect(f.resolved).toHaveBeenCalledTimes(1);
});

it("retains and replays exact-reference refreshes across a temporary source failure", async () => {
  const f = fixture();
  const initial = await f.request("/plan/resolve", input);
  const token = (initial.body as MobilityEnvelope<TripPlan>).data.itineraries[0].refreshToken;
  f.setHealthy(false);
  const unavailable = await f.request("/plan/refresh", { token });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.headers["Retry-After"]).toBe("2");
  f.setHealthy(true);
  const success = await f.request("/plan/refresh", { token });
  expect(success.statusCode).toBe(200);
  expect(success.body).toHaveProperty("data.fallbackOccurred", false);
  const exact = JSON.parse(JSON.stringify(success.body));
  expect((await f.request("/plan/refresh", { token })).body).toEqual(exact);
  expect(f.resolved).toHaveBeenCalledTimes(2);
  expect(f.planned).not.toHaveBeenCalled();
});
