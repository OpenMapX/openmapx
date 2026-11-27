import type {
  IntegrationContext,
  TransitProvider,
  TripPlanRequest,
} from "@openmapx/integration-framework";
import { nth } from "@openmapx/integration-framework/testing";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TripPlan } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

interface Reply {
  statusCode: number;
  body?: unknown;
  header(name: string, value: string): Reply;
  status(code: number): Reply;
  send(value: unknown): Reply;
}
type Handler = (request: { query: Record<string, string> }, reply: Reply) => Promise<void>;

const BRUSSELS = { from_lat: "50.85", from_lng: "4.35" };
const ANTWERP = { to_lat: "51.22", to_lng: "4.42" };
const NOW = new Date("2026-11-10T08:15:42.123Z");

function tripPlan(cursors: { next?: string; previous?: string } = {}): TripPlan {
  const from = { name: "Bruxelles-Central", stopId: "pt:a", lat: 50.85, lng: 4.35 };
  const to = { name: "Antwerpen-Centraal", stopId: "pt:b", lat: 51.22, lng: 4.42 };
  return {
    from,
    to,
    source: "transit-plan-test",
    instance: "pt",
    provider: "pt",
    datasetEpoch: "E1",
    ...(cursors.next ? { nextPageCursor: cursors.next } : {}),
    ...(cursors.previous ? { previousPageCursor: cursors.previous } : {}),
    itineraries: [
      {
        id: "itinerary-1",
        startTime: "2026-11-10T09:00:00.000Z",
        endTime: "2026-11-10T09:45:00.000Z",
        duration: 2700,
        transfers: 0,
        walkDistance: 0,
        legs: [
          {
            mode: "rail",
            from,
            to,
            startTime: "2026-11-10T09:00:00.000Z",
            endTime: "2026-11-10T09:45:00.000Z",
            geometry: {
              type: "LineString",
              coordinates: [
                [4.35, 50.85],
                [4.42, 51.22],
              ],
            },
          },
        ],
      },
    ],
  };
}

/** The route under a real orchestrator with one planner, whose requests are the boundary. */
function fixture() {
  const planTrip = vi.fn(async (_request: TripPlanRequest) =>
    withAttribution(
      [tripPlan({ next: "cursor-next", previous: "cursor-prev" })],
      [],
      freshnessNow(),
    ),
  );
  const provider: TransitProvider = {
    id: "transit-plan-test",
    prefix: "pt:",
    priority: 1,
    role: "baseline",
    coverage: { all: true },
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
      planning: true,
      planningFeatures: {
        maxTransfers: true,
        transferBuffer: true,
        wheelchairRequired: true,
        bikeTransport: false,
        elevation: false,
        rentalFilters: false,
        detailedTransfers: false,
        paging: true,
        refresh: false,
      },
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    healthCheck: async () => ({ status: "up" }),
    planTrip,
  };
  const handlers = new Map<string, Handler>();
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      withCache: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
    },
    providerHealth: {
      isHealthy: async () => true,
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    getProviderOrder: () => [],
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

  async function plan(query: Record<string, string>) {
    const handler = handlers.get("GET /plan");
    if (!handler) throw new Error("Missing GET /plan");
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
    await handler({ query }, reply);
    return reply;
  }
  return { plan, planTrip };
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-plan-route-secret");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /plan parameters", () => {
  it.each([
    ["a missing origin", { ...ANTWERP }],
    ["an origin outside WGS 84", { from_lat: "91", from_lng: "4.35", ...ANTWERP }],
    ["an impossible date", { ...BRUSSELS, ...ANTWERP, date: "2026-02-30", time: "08:00" }],
    ["a date in another format", { ...BRUSSELS, ...ANTWERP, date: "2026/02/01" }],
    ["a clock without leading zero", { ...BRUSSELS, ...ANTWERP, time: "9:30" }],
    ["a clock past midnight", { ...BRUSSELS, ...ANTWERP, time: "24:00" }],
    ["more than eight transfers", { ...BRUSSELS, ...ANTWERP, max_transfers: "9" }],
    ["fractional transfers", { ...BRUSSELS, ...ANTWERP, max_transfers: "1.5" }],
    ["an unknown transfer buffer", { ...BRUSSELS, ...ANTWERP, transfer_buffer: "huge" }],
    ["an unknown hill preference", { ...BRUSSELS, ...ANTWERP, bike_hill_preference: "flat" }],
    [
      "a rental filter without a rental mode",
      { ...BRUSSELS, ...ANTWERP, rental_form_factors: "BICYCLE" },
    ],
    [
      "bike transport with car share",
      {
        ...BRUSSELS,
        ...ANTWERP,
        pre_modes: "RENTAL",
        rental_form_factors: "CAR",
        require_bike_transport: "true",
      },
    ],
    [
      "a provider filter without its source",
      { ...BRUSSELS, ...ANTWERP, pre_modes: "RENTAL", rental_provider_ids: "nextbike" },
    ],
    ["a forged page token", { ...BRUSSELS, ...ANTWERP, page_token: "not-a-token" }],
  ])("answers 400 without planning for %s", async (_case, query) => {
    const { plan, planTrip } = fixture();

    const reply = await plan(query);

    expect(reply.statusCode).toBe(400);
    expect(planTrip).not.toHaveBeenCalled();
  });

  it("answers 422 when no planner offers a requirement", async () => {
    const { plan, planTrip } = fixture();

    const reply = await plan({ ...BRUSSELS, ...ANTWERP, require_bike_transport: "true" });

    expect(reply.statusCode).toBe(422);
    expect(reply.body).toMatchObject({ unsupportedCapabilities: ["bikeTransport"] });
    expect(planTrip).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>, Partial<TripPlanRequest>]>([
    [
      "nothing optional",
      {},
      {
        departureTime: "2026-11-10T08:15:42Z",
        modes: ["TRANSIT"],
        numItineraries: undefined,
        maxTransfers: undefined,
        transferBuffer: "standard",
        bikeHillPreference: "default",
        wheelchairRequired: false,
        requireBikeTransport: false,
        deutschlandticketOnly: false,
        pageCursor: undefined,
      },
    ],
    [
      "a clock on a date",
      { date: "2026-12-24", time: "17:30" },
      { departureTime: "2026-12-24T17:30:00Z" },
    ],
    [
      "an arrival deadline",
      { time: "2026-07-01T08:30:00+02:00", arrive_by: "true" },
      { arrivalTime: "2026-07-01T06:30:00Z" },
    ],
    ["listed modes", { modes: "BUS, TRAM" }, { modes: ["BUS", "TRAM"] }],
    ["too many itineraries", { num_itineraries: "25" }, { numItineraries: 10 }],
    ["a fractional itinerary count", { num_itineraries: "3.7" }, { numItineraries: 3 }],
    ["no itineraries", { num_itineraries: "0" }, { numItineraries: undefined }],
    [
      "accessibility and transfer needs",
      {
        wheelchair: "true",
        max_transfers: "0",
        transfer_buffer: "extra",
        deutschlandticket: "true",
      },
      {
        wheelchairRequired: true,
        maxTransfers: 0,
        transferBuffer: "extra",
        deutschlandticketOnly: true,
      },
    ],
  ])("plans %s", async (_case, query, expected) => {
    const { plan, planTrip } = fixture();

    const reply = await plan({ ...BRUSSELS, ...ANTWERP, ...query });

    expect(reply.statusCode).toBe(200);
    expect(planTrip).toHaveBeenCalledTimes(1);
    const request = nth(planTrip.mock.calls, 0)[0];
    expect(request).toMatchObject({
      from: { lat: 50.85, lng: 4.35 },
      to: { lat: 51.22, lng: 4.42 },
      ...expected,
    });
    if ("arrivalTime" in expected) expect(request.departureTime).toBeUndefined();
    else expect(request.arrivalTime).toBeUndefined();
  });
});

describe("GET /plan page tokens", () => {
  const search = { ...BRUSSELS, ...ANTWERP, date: "2026-11-10", time: "09:00" };

  async function firstPage() {
    const route = fixture();
    const reply = await route.plan(search);
    const page = (reply.body as { data: TripPlan }).data;
    return { ...route, page };
  }

  it("signs the planner's cursors instead of passing them out", async () => {
    const { page } = await firstPage();

    expect(page.nextPageToken).toEqual(expect.any(String));
    expect(page.previousPageToken).toEqual(expect.any(String));
    expect(page).not.toHaveProperty("nextPageCursor");
    expect(page).not.toHaveProperty("previousPageCursor");
  });

  it.each([
    ["next", "nextPageToken", "cursor-next"],
    ["previous", "previousPageToken", "cursor-prev"],
  ] as const)(
    "hands the %s cursor back to the planner for the same search",
    async (_direction, field, cursor) => {
      const { plan, planTrip, page } = await firstPage();

      const reply = await plan({ ...search, page_token: page[field] ?? "" });

      expect(reply.statusCode).toBe(200);
      expect(nth(planTrip.mock.calls, 1)[0].pageCursor).toBe(cursor);
    },
  );

  it.each([
    ["another destination", { to_lat: "51.05" }],
    ["another time", { time: "10:00" }],
    ["arriving instead of departing", { arrive_by: "true" }],
    ["another dataset", { capability_epoch: "E2" }],
  ])("refuses a token for %s", async (_case, change) => {
    const { plan, planTrip, page } = await firstPage();

    const reply = await plan({ ...search, ...change, page_token: page.nextPageToken ?? "" });

    expect(reply.statusCode).toBe(400);
    expect(planTrip).toHaveBeenCalledTimes(1);
  });
});
