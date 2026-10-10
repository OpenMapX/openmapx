import { setup as setupCrowdReports } from "@integrations/crowd-reports";
import { setup as setupTransit } from "@integrations/transit";
import { ApiClient, fetchVehicleJourney } from "@openmapx/core";
import type {
  IntegrationContext,
  LoadedIntegration,
  TransitProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("requireAuth should not be called")),
}));

import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";
import { buildTestApp } from "../../test/app.js";

const FRESHNESS = { fetchedAt: "2026-10-05T10:00:00.000Z", hasRealtimeData: false, isStale: false };

/** Every id a transit provider method was called with, in call order. */
const calls: { op: string; ids: unknown[] }[] = [];

function result<T>(data: T) {
  return { data, attributions: [], freshness: FRESHNESS };
}

const transitProvider = {
  id: "fake",
  prefix: "",
  coverage: { all: true },
  priority: 1,
  role: "primary",
  capabilities: {},
  attribution: [],
  getStop: async (id: string) => {
    calls.push({ op: "getStop", ids: [id] });
    return result({ id, name: "Stop" });
  },
  getDepartures: async (id: string) => {
    calls.push({ op: "getDepartures", ids: [id] });
    return result([]);
  },
  getRoute: async (id: string) => {
    calls.push({ op: "getRoute", ids: [id] });
    return result({ id, shortName: "1" });
  },
  getRouteStops: async (id: string, hint?: string) => {
    calls.push({ op: "getRouteStops", ids: [id, hint] });
    return result([]);
  },
  getRoutesForStop: async (id: string) => {
    calls.push({ op: "getRoutesForStop", ids: [id] });
    return result([]);
  },
  getVehicleJourney: async (id: string, fallbackIds?: string[]) => {
    calls.push({ op: "getVehicleJourney", ids: [id, fallbackIds] });
    return result({ id, stops: [] });
  },
} as unknown as TransitProvider;

function contextFor(id: string): IntegrationContext {
  const ctx = createMockIntegrationContext({ id });
  const transitIntegration = {
    id: "fake-transit",
    manifest: { dataSources: [] },
    providers: new Map([["transit", [transitProvider]]]),
  } as unknown as LoadedIntegration;
  Object.assign(ctx, {
    getIntegrationsByDomain: ((domain: string) =>
      domain === "transit"
        ? [transitIntegration]
        : []) as IntegrationContext["getIntegrationsByDomain"],
    registerRoute: (
      method: string,
      path: string,
      handler: Parameters<typeof registerIntegrationRoute>[3],
      options?: Parameters<typeof registerIntegrationRoute>[4],
    ) => registerIntegrationRoute(id, method, path, handler, options),
  });
  return ctx;
}

async function plugin(fastify: FastifyInstance): Promise<void> {
  setupTransit(contextFor("transit"));
  setupCrowdReports(contextFor("crowd-reports"));
  const loaded = (id: string) => [id, { id, enabled: true } as LoadedIntegration] as const;
  registerIntegrationRouteDispatcher(
    fastify,
    new Map([loaded("transit"), loaded("crowd-reports")]),
  );
}

const TRANSIT_IDS = [
  "ms:stop:de:08111:6008:1/2",
  "mo:feed_50%_off:stop",
  "db:A=1@O=Berlin Hbf@X=13369549@Y=52525589@L=8011160@",
  "ms:stop#3:a%20b",
  "ms:stop:a?b=c&d",
];

describe("integration route params over the production dispatcher", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    calls.length = 0;
    resetIntegrationRoutes();
    app = await buildTestApp(plugin as FastifyPluginAsync);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    resetIntegrationRoutes();
  });

  const transit = (path: string) => `/api/integrations/transit${path}`;

  it.each(TRANSIT_IDS)("a stop id reaches the provider decoded exactly once: %s", async (id) => {
    const response = await app.inject({
      method: "GET",
      url: transit(`/stops/${encodeURIComponent(id)}`),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getStop", ids: [id] }]);
    expect(response.json().data.id).toBe(id);
  });

  it.each(TRANSIT_IDS)("a stop subroute receives the id decoded exactly once: %s", async (id) => {
    const response = await app.inject({
      method: "GET",
      url: transit(`/stops/${encodeURIComponent(id)}/departures?minutes=30`),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getDepartures", ids: [id] }]);
  });

  it.each(TRANSIT_IDS)("a route id and its hint stop are decoded exactly once: %s", async (id) => {
    const route = await app.inject({
      method: "GET",
      url: transit(`/routes/${encodeURIComponent(id)}`),
    });
    expect(route.statusCode, route.body).toBe(200);

    const query = new URLSearchParams({ hint_stop_id: id });
    const stops = await app.inject({
      method: "GET",
      url: transit(`/routes/${encodeURIComponent(id)}/stops?${query}`),
    });
    expect(stops.statusCode, stops.body).toBe(200);

    const forStop = await app.inject({
      method: "GET",
      url: transit(`/routes?${new URLSearchParams({ stop_id: id })}`),
    });
    expect(forStop.statusCode, forStop.body).toBe(200);

    // Routes-for-stop also enriches from the stop's departures; every id the
    // provider saw, on any call, must be the original.
    expect(calls).toEqual(
      expect.arrayContaining([
        { op: "getRoute", ids: [id] },
        { op: "getRouteStops", ids: [id, id] },
        { op: "getRoutesForStop", ids: [id] },
      ]),
    );
    expect(new Set(calls.flatMap((call) => call.ids))).toEqual(new Set([id]));
  });

  it.each(TRANSIT_IDS)(
    "a vehicle id and its fallbacks are decoded exactly once: %s",
    async (id) => {
      const query = new URLSearchParams({ fallback_ids: id });
      const response = await app.inject({
        method: "GET",
        url: transit(`/vehicles/${encodeURIComponent(id)}?${query}`),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(calls).toEqual([{ op: "getVehicleJourney", ids: [id, [id]] }]);
    },
  );

  it("fallback ids built by the client reach the provider verbatim, commas and edge spaces kept", async () => {
    const tripId = "ms:trip:a,b";
    const fallbackIds = ["db:x,y@z", " ms:lead", "trail ", "mo:a?b=c&d"];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await fetchVehicleJourney(
      { tripId, fallbackIds },
      new ApiClient({ baseUrl: "https://api.example/", credentials: "omit" }),
    );
    vi.unstubAllGlobals();
    const built = new URL(urls[0] as string);

    const response = await app.inject({ method: "GET", url: `${built.pathname}${built.search}` });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getVehicleJourney", ids: [tripId, fallbackIds] }]);
  });

  it("a single fallback id is read as a one-element list", async () => {
    const response = await app.inject({
      method: "GET",
      url: transit(`/vehicles/t1?${new URLSearchParams({ fallback_ids: " a,b " })}`),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getVehicleJourney", ids: ["t1", [" a,b "]] }]);
  });

  it("an empty fallback_ids is ignored as if absent", async () => {
    const response = await app.inject({
      method: "GET",
      url: transit("/vehicles/t1?fallback_ids="),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getVehicleJourney", ids: ["t1", undefined] }]);
  });

  it("an empty item among repeated fallback_ids is dropped", async () => {
    const response = await app.inject({
      method: "GET",
      url: transit("/vehicles/t1?fallback_ids=a&fallback_ids="),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getVehicleJourney", ids: ["t1", ["a"]] }]);
  });

  it("no fallback ids means none are passed on", async () => {
    const response = await app.inject({ method: "GET", url: transit("/vehicles/t1") });

    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toEqual([{ op: "getVehicleJourney", ids: ["t1", undefined] }]);
  });

  it.each(["/stops/ms%3A50%", "/stops/ms%3A50%2", "/stops/ms%3A50%/departures?minutes=30"])(
    "a malformed escape is the router's 400, never reaching the dispatcher: %s",
    async (path) => {
      const response = await app.inject({ method: "GET", url: transit(path) });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().code).toBe("FST_ERR_BAD_URL");
      expect(calls).toEqual([]);
    },
  );

  it("a crowd-report id is decoded once before the relay re-encodes it", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const id = "oc:feature:x:a b@c=d#e%20f";

    const response = await app.inject({
      method: "POST",
      url: `/api/integrations/crowd-reports/reports/feature/${encodeURIComponent(id)}/confirm`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const relayed = String(fetchMock.mock.calls[0]?.[0]);
    expect(relayed.endsWith(`/contrib/reports/feature/${encodeURIComponent(id)}/confirm`)).toBe(
      true,
    );
  });

  it("a crowd-report id with a slash reaches the handler, which rejects it", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: `/api/integrations/crowd-reports/reports/feature/${encodeURIComponent("a/b")}/confirm`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe("invalid record class, id or action");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the dispatcher's raw path against the router's configuration", () => {
  beforeEach(() => {
    calls.length = 0;
    resetIntegrationRoutes();
  });

  afterEach(() => {
    resetIntegrationRoutes();
  });

  const normalisingOptions = [
    "ignoreDuplicateSlashes",
    "useSemicolonDelimiter",
    "ignoreTrailingSlash",
  ];

  it.each(normalisingOptions)("refuses a router configured with %s", (option) => {
    const app = Fastify({ logger: false, routerOptions: { [option]: true } });

    expect(() => registerIntegrationRouteDispatcher(app, new Map())).toThrow(
      new RegExp(`router option "${option}"`),
    );
  });

  it.each(normalisingOptions)("refuses %s set through the top-level server option", (option) => {
    const app = Fastify({ logger: false, [option]: true });

    expect(() => registerIntegrationRouteDispatcher(app, new Map())).toThrow(
      new RegExp(`router option "${option}"`),
    );
  });

  it.each([
    ["top-level", { caseSensitive: false }],
    ["routerOptions", { routerOptions: { caseSensitive: false } }],
  ])(
    "a case-insensitive router (%s) still routes mixed-case ids verbatim",
    async (_where, options) => {
      const app = Fastify({ logger: false, ...options });
      await app.register(plugin as FastifyPluginAsync);
      await app.ready();
      const id = "ms:Stop:DE:08111:6008:1/2";

      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/integrations/transit/stops/${encodeURIComponent(id)}`,
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(calls).toEqual([{ op: "getStop", ids: [id] }]);

        calls.length = 0;
        const mixedCase = await app.inject({
          method: "GET",
          url: `/API/Integrations/transit/stops/${encodeURIComponent(id)}`,
        });

        expect(mixedCase.statusCode, mixedCase.body).toBe(200);
        expect(calls).toEqual([{ op: "getStop", ids: [id] }]);
      } finally {
        await app.close();
      }
    },
  );

  it("the default case-sensitive router does not route a mixed-case prefix", async () => {
    const app = Fastify({ logger: false });
    await app.register(plugin as FastifyPluginAsync);
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/API/Integrations/transit/stops/${encodeURIComponent("ms:stop:1")}`,
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("follows a rewriteUrl hook that changes the segment count before the dispatcher", async () => {
    const app = Fastify({
      logger: false,
      rewriteUrl: (req) => (req.url ?? "/").replace(/^\/v2\/a\/b\/c\//, "/api/integrations/"),
    });
    await app.register(plugin as FastifyPluginAsync);
    await app.ready();
    const id = "ms:stop:de:08111:6008:1/2";

    try {
      const response = await app.inject({
        method: "GET",
        url: `/v2/a/b/c/transit/stops/${encodeURIComponent(id)}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(calls).toEqual([{ op: "getStop", ids: [id] }]);
    } finally {
      await app.close();
    }
  });
});
