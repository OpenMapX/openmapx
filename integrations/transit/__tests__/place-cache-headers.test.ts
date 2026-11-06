import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

type Handler = (
  req: { query: Record<string, string>; params: Record<string, string> },
  reply: Reply,
) => Promise<void>;
interface Reply {
  headers: Record<string, string>;
  statusCode: number;
  body?: unknown;
  header(name: string, value: string): Reply;
  status(code: number): Reply;
  send(body: unknown): Reply;
}

const central: TransitStop = {
  id: "a:central",
  provider: "a",
  name: "Central",
  lat: 50,
  lng: 7,
  modes: [],
};

function provider(id: string, search: TransitProvider["searchStopsByName"]): TransitProvider {
  return {
    id,
    prefix: `${id}:`,
    coverage: { all: true },
    priority: 5,
    role: "regional",
    attribution: [],
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
      departures: false,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehicleJourney: false,
    },
    healthCheck: async () => ({ healthy: true }),
    searchStopsByName: search,
  };
}

function routes(providers: TransitProvider[]): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ctx = {
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
    providerHealth: {
      isHealthy: async () => true,
      recordSuccess: async () => {},
      recordFailure: async () => {},
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    getIntegrationsByDomain: (domain: string) =>
      domain === "transit"
        ? [{ manifest: { dataSources: [] }, providers: new Map([["transit", providers]]) }]
        : [],
    registerSearchSuggestionProvider: () => {},
    registerRoute: (method: string, path: string, handler: Handler) => {
      handlers.set(`${method} ${path}`, handler);
    },
  } as unknown as IntegrationContext;
  setup(ctx);
  return handlers;
}

function reply(): Reply {
  const r: Reply = {
    headers: {},
    statusCode: 200,
    header(name, value) {
      r.headers[name] = value;
      return r;
    },
    status(code) {
      r.statusCode = code;
      return r;
    },
    send(body) {
      r.body = body;
      return r;
    },
  };
  return r;
}

const answering = () =>
  provider(
    "a",
    vi.fn(async () => withAttribution([central], [], freshnessNow())),
  );
const failing = () =>
  provider(
    "b",
    vi.fn(async () => {
      throw new Error("upstream down");
    }),
  );
const place = { lat: "50", lng: "7", name: "Central" };

describe("transit place response caching", () => {
  it.each([
    ["GET /stops/near-place", place, "public, max-age=86400, s-maxage=86400"],
    ["GET /routes/for-place", place, "public, max-age=300, s-maxage=300"],
    ["GET /facilities/for-place", place, "public, max-age=86400, s-maxage=86400"],
    ["GET /alerts/for-place", place, "public, max-age=60, s-maxage=60"],
    ["GET /stops/search", { q: "Central" }, "public, max-age=300, s-maxage=300"],
  ])("%s lets clients keep a complete answer", async (route, query, complete) => {
    const res = reply();
    await routes([answering()]).get(route)?.({ query, params: {} }, res);
    expect(res.headers["Cache-Control"]).toBe(complete);
  });

  it.each([
    ["GET /stops/near-place", place],
    ["GET /routes/for-place", place],
    ["GET /facilities/for-place", place],
    ["GET /alerts/for-place", place],
    ["GET /stops/search", { q: "Central" }],
  ])("%s keeps a partial answer out of browser and shared caches", async (route, query) => {
    const res = reply();
    await routes([answering(), failing()]).get(route)?.({ query, params: {} }, res);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({ freshness: { isPartial: true } });
  });

  it("sets no cacheable header when the lookup fails", async () => {
    const res = reply();
    await expect(
      routes([failing()]).get("GET /stops/near-place")?.({ query: place, params: {} }, res),
    ).rejects.toThrow("Transit stop sources unavailable");
    expect(res.headers["Cache-Control"]).toBeUndefined();
  });
});

it("opts public point-to-point planning into regional alternatives", async () => {
  const planTrip = vi.fn(async () =>
    withAttribution(
      [
        {
          from: { name: "A", lat: 50, lng: 6 },
          to: { name: "B", lat: 51, lng: 7 },
          itineraries: [
            {
              duration: 60,
              startTime: "2026-11-06T20:41:00Z",
              endTime: "2026-11-06T20:42:00Z",
              walkDistance: 0,
              transfers: 0,
              legs: [],
            },
          ],
        },
      ],
      [],
      freshnessNow(),
    ),
  );
  const p = answering();
  p.planTrip = planTrip;
  p.capabilities.planning = true;
  const handlers = routes([p]);
  const res = reply();
  await handlers.get("GET /plan")?.(
    {
      query: {
        from_lat: "50",
        from_lng: "6",
        to_lat: "51",
        to_lng: "7",
        time: "2026-11-06T20:41:00Z",
      },
      params: {},
    },
    res,
  );
  expect(res.statusCode).toBe(200);
  expect(planTrip).toHaveBeenCalledWith(
    expect.objectContaining({ regionalAlternatives: true, departureTime: "2026-11-06T20:41:00Z" }),
  );
});

it("rejects malformed anchored departure times before provider acquisition", async () => {
  const handlers = routes([]);
  const handler = handlers.get("GET /stops/:id/departures")!;
  for (const time of [
    "tomorrow",
    "2026-02-31T10:00:00Z",
    "2026-11-06T25:00:00Z",
    "2026-11-06T20:18:00Z".repeat(3),
  ]) {
    const r = reply();
    await handler({ query: { time, minutes: "5" }, params: { id: "a:central" } }, r);
    expect(r.statusCode).toBe(400);
  }
});
it("canonicalizes anchored time and returns no-store; current-only providers return 501", async () => {
  const p = answering();
  p.getDeparturesAt = vi.fn(async () => withAttribution([], [], freshnessNow()));
  const handler = routes([p]).get("GET /stops/:id/departures")!;
  const r = reply();
  await handler(
    { query: { time: "2026-11-06T20:17:00Z", minutes: "5" }, params: { id: "a:central" } },
    r,
  );
  expect(r.statusCode).toBe(200);
  expect(r.headers["Cache-Control"]).toBe("no-store");
  expect(p.getDeparturesAt).toHaveBeenCalledWith("a:central", 5, "2026-11-06T20:17:00.000Z");
  const unsupported = reply();
  await routes([answering()]).get("GET /stops/:id/departures")?.(
    { query: { time: "2026-11-06T20:17:00Z", minutes: "5" }, params: { id: "a:central" } },
    unsupported,
  );
  expect(unsupported.statusCode).toBe(501);
});
