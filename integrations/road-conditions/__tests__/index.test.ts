import { routeFingerprint } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { parseBbox, setup } from "../index.js";
import type { RoadConditionEvent, RoadConditionsProvider, RoadFlowSegment } from "../types.js";

type Handler = (
  req: { query: Record<string, string | undefined>; body: unknown },
  reply: {
    status: (code: number) => { send: (body: unknown) => void };
    header: (k: string, v: string) => void;
    send: (body: unknown) => void;
  },
) => Promise<void>;

/** The handler `setup` registered for `path`, failing loudly when it registered none. */
function handlerFor(routes: Map<string, Handler>, path: string): Handler {
  const handler = routes.get(path);
  if (!handler) throw new Error(`no route registered for ${path}`);
  return handler;
}

/**
 * Drives the `/events` route with a stub host: records the cache key each call
 * derives and the query options the aggregation would run under. Defaults to
 * no providers registered and a pass-through cache; both can be overridden to
 * exercise partial-provider-failure and total-aggregation-failure paths.
 */
function eventsHarness(opts?: {
  providers?: RoadConditionsProvider[];
  withCache?: <T>(key: string, ttl: number, fn: () => Promise<T>) => Promise<T>;
}) {
  const cacheKeys: string[] = [];
  const integrations = (opts?.providers ?? []).map((p) => ({
    id: p.id,
    providers: new Map<string, RoadConditionsProvider[]>([["road-conditions", [p]]]),
  }));
  const routes = new Map<string, Handler>();
  const ctx = {
    registerRoute(_method: string, path: string, handler: Handler) {
      routes.set(path, handler);
    },
    cache: {
      async withCache<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
        cacheKeys.push(key);
        return opts?.withCache ? opts.withCache(key, ttl, fn) : fn();
      },
    },
    getIntegrationsByDomain: () => integrations,
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as IntegrationContext;

  setup(ctx);

  return {
    cacheKeys,
    async get(query: Record<string, string | undefined>) {
      let status = 200;
      let body: unknown;
      const headers: Record<string, string> = {};
      await handlerFor(routes, "/events")(
        { query, body: undefined },
        {
          status: (code) => {
            status = code;
            return { send: (b: unknown) => (body = b) };
          },
          header: (k: string, v: string) => {
            headers[k] = v;
          },
          send: (b: unknown) => (body = b),
        },
      );
      return { status, body, headers };
    },
  };
}

/** A minimal events-capable provider, mirroring the orchestrator's own test fixtures. */
function eventsProvider(
  id: string,
  getEvents: RoadConditionsProvider["getEvents"],
): RoadConditionsProvider {
  return { id, getEvents };
}

/** A minimal event fixture, mirroring the orchestrator's own test fixtures. */
function event(
  over: Partial<RoadConditionEvent> & Pick<RoadConditionEvent, "id">,
): RoadConditionEvent {
  return {
    source: "s",
    provider: "",
    type: "accident",
    severity: "high",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    headline: "Accident on A1",
    ...over,
  };
}

/** A minimal flow-capable provider, mirroring the orchestrator's own test fixtures. */
function flowProvider(
  id: string,
  getFlow: NonNullable<RoadConditionsProvider["getFlow"]>,
): RoadConditionsProvider {
  return { id, getEvents: async () => [], getFlow };
}

/** A flow segment along the `[8,50] → [8,50.01]` line used by the tests below. */
function flowSegment(
  over: Partial<RoadFlowSegment> & Pick<RoadFlowSegment, "id">,
): RoadFlowSegment {
  return {
    geometry: {
      type: "LineString",
      coordinates: [
        [8, 50],
        [8, 50.01],
      ],
    },
    los: "heavy",
    confidence: "measured",
    direction: "f",
    ...over,
  };
}

/**
 * Drives the `/flow-along-route` route with a stub host. Defaults to no
 * providers registered (every route resolves to an empty span list) and a
 * pass-through cache; both can be overridden to exercise provider matching
 * and per-route failure isolation.
 */
function flowRouteHarness(opts?: {
  providers?: RoadConditionsProvider[];
  withCache?: <T>(key: string, ttl: number, fn: () => Promise<T>) => Promise<T>;
}) {
  const integrations = (opts?.providers ?? []).map((p) => ({
    id: p.id,
    providers: new Map<string, RoadConditionsProvider[]>([["road-conditions", [p]]]),
  }));
  const routes = new Map<string, Handler>();
  const ctx = {
    registerRoute(_method: string, path: string, handler: Handler) {
      routes.set(path, handler);
    },
    cache: {
      withCache:
        opts?.withCache ?? (async <T>(_key: string, _ttl: number, fn: () => Promise<T>) => fn()),
    },
    getIntegrationsByDomain: () => integrations,
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as IntegrationContext;

  setup(ctx);

  return {
    async post(body: unknown) {
      let status = 200;
      let resBody: unknown;
      await handlerFor(routes, "/flow-along-route")(
        { query: {}, body },
        {
          status: (code) => {
            status = code;
            return { send: (b: unknown) => (resBody = b) };
          },
          header: () => {},
          send: (b: unknown) => (resBody = b),
        },
      );
      return { status, body: resBody };
    },
  };
}

describe("parseBbox", () => {
  it("parses a valid bbox", () => {
    expect(parseBbox("-1,51,1,52")).toEqual([-1, 51, 1, 52]);
  });

  it("returns null for missing input", () => {
    expect(parseBbox(undefined)).toBeNull();
  });

  it("rejects a blank segment instead of silently substituting 0", () => {
    expect(parseBbox("1,,3,4")).toBeNull();
  });

  it("rejects non-finite segments", () => {
    expect(parseBbox("1,NaN,3,4")).toBeNull();
    expect(parseBbox("1,2,3")).toBeNull();
  });

  it("rejects out-of-range longitude", () => {
    expect(parseBbox("-181,51,1,52")).toBeNull();
    expect(parseBbox("-1,51,181,52")).toBeNull();
  });

  it("rejects out-of-range latitude", () => {
    expect(parseBbox("-1,-91,1,52")).toBeNull();
    expect(parseBbox("-1,51,1,91")).toBeNull();
  });

  it("rejects an inverted box where south > north", () => {
    expect(parseBbox("-1,52,1,51")).toBeNull();
  });

  it("rejects an inverted box where west > east (antimeridian boxes unsupported)", () => {
    expect(parseBbox("170,10,-170,20")).toBeNull();
  });
});

describe("GET /events horizonDays", () => {
  const BBOX = "13.39,52.49,13.41,52.51";

  it("gives each horizon its own cache key", async () => {
    const h = eventsHarness();
    await h.get({ bbox: BBOX });
    await h.get({ bbox: BBOX, horizonDays: "0" });
    await h.get({ bbox: BBOX, horizonDays: "7" });
    expect(new Set(h.cacheKeys).size).toBe(3);
    expect(h.cacheKeys[1]).toMatch(/:0$/);
    expect(h.cacheKeys[2]).toMatch(/:7$/);
  });

  it("treats a non-integer or negative horizon as absent, not as 0", async () => {
    const h = eventsHarness();
    await h.get({ bbox: BBOX });
    const noParam = h.cacheKeys[0];
    await h.get({ bbox: BBOX, horizonDays: "abc" });
    await h.get({ bbox: BBOX, horizonDays: "-1" });
    await h.get({ bbox: BBOX, horizonDays: "1.5" });
    expect(h.cacheKeys).toEqual([noParam, noParam, noParam, noParam]);
  });

  it("still rejects a malformed bbox", async () => {
    const h = eventsHarness();
    const res = await h.get({ bbox: "1,,3,4", horizonDays: "0" });
    expect(res.status).toBe(400);
  });
});

describe("GET /events failure semantics", () => {
  const BBOX = "13.39,52.49,13.41,52.51";

  it("responds 503 with no-cache when the whole aggregation throws, never a 200 empty collection", async () => {
    // Nothing about this is a per-provider failure — `Promise.allSettled` never
    // runs because the failure is in the cache layer wrapping it, so this
    // exercises the "everything failed" path navigation must not mistake for
    // "the road ahead is clear".
    const h = eventsHarness({
      withCache: async () => {
        throw new Error("cache backend down");
      },
    });
    const res = await h.get({ bbox: BBOX });
    expect(res.status).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.body).toEqual({ error: "road-conditions aggregation failed" });
  });

  it("responds 200 with a cacheable empty collection for a genuine empty result", async () => {
    const h = eventsHarness();
    const res = await h.get({ bbox: BBOX });
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("public, max-age=90, s-maxage=90");
    expect(res.body).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("responds 200 with the surviving providers' events when only some providers fail", async () => {
    const h = eventsHarness({
      providers: [
        eventsProvider("road-conditions-ok", async () => [event({ id: "ok:1" })]),
        eventsProvider("road-conditions-broken", async () => {
          throw new Error("upstream down");
        }),
      ],
    });
    const res = await h.get({ bbox: BBOX });
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("public, max-age=90, s-maxage=90");
    const body = res.body as { type: string; features: Array<{ properties: { id: string } }> };
    expect(body.type).toBe("FeatureCollection");
    expect(body.features.map((f) => f.properties.id)).toEqual(["ok:1"]);
  });
});

describe("POST /flow-along-route", () => {
  it("rejects a malformed body with 400", async () => {
    const harness = flowRouteHarness();
    const { status } = await harness.post({ routes: [] });
    expect(status).toBe(400);
  });

  it("returns one entry per submitted route when no provider has flow", async () => {
    const harness = flowRouteHarness();
    const { body } = await harness.post({
      routes: [
        {
          id: "r0",
          geometry: [
            [8, 50],
            [8, 50.01],
          ],
        },
        {
          id: "r1",
          geometry: [
            [8, 50],
            [8.01, 50],
          ],
        },
      ],
    });
    expect(body).toEqual({
      routes: [
        { id: "r0", spans: [] },
        { id: "r1", spans: [] },
      ],
    });
  });

  it("drops a free-flow span and an unknown span, keeping neither on the wire", async () => {
    const harness = flowRouteHarness({
      providers: [
        flowProvider("congestion", async () => [
          flowSegment({ id: "free", los: "free_flow" }),
          flowSegment({ id: "dunno", los: "unknown" }),
        ]),
      ],
    });
    const { body } = await harness.post({
      routes: [
        {
          id: "r0",
          geometry: [
            [8, 50],
            [8, 50.01],
          ],
        },
      ],
    });
    expect(body).toEqual({ routes: [{ id: "r0", spans: [] }] });
  });

  it("keeps a degraded span matched onto the route", async () => {
    const harness = flowRouteHarness({
      providers: [
        flowProvider("congestion", async () => [flowSegment({ id: "jam", los: "heavy" })]),
      ],
    });
    const { body } = (await harness.post({
      routes: [
        {
          id: "r0",
          geometry: [
            [8, 50],
            [8, 50.01],
          ],
        },
      ],
    })) as { body: { routes: Array<{ id: string; spans: Array<{ los: string }> }> } };
    const spans = body.routes[0].spans;
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].los).toBe("heavy");
  });

  it("degrades only the route whose own processing fails, leaving a healthy route in the same request intact", async () => {
    const r0Geometry: [number, number][] = [
      [8, 50],
      [8, 50.01],
    ];
    const r1Geometry: [number, number][] = [
      [9, 50],
      [9, 50.01],
    ];
    // Simulate a failure that has nothing to do with any provider (e.g. a
    // cache backend error) for r0's cache key specifically, so a pass on r1
    // in the same request proves the failure is scoped to one route.
    const failingKey = `conditions:query:flowroute:${routeFingerprint(r0Geometry)}`;
    const harness = flowRouteHarness({
      providers: [
        flowProvider("congestion", async (bbox) => {
          const [west, , east] = bbox;
          if (west <= 9 && 9 <= east) {
            return [
              flowSegment({
                id: "jam-r1",
                geometry: { type: "LineString", coordinates: r1Geometry },
              }),
            ];
          }
          return [];
        }),
      ],
      withCache: async (key, _ttl, fn) => {
        if (key === failingKey) throw new Error("cache backend down");
        return fn();
      },
    });

    const { status, body } = (await harness.post({
      routes: [
        { id: "r0", geometry: r0Geometry },
        { id: "r1", geometry: r1Geometry },
      ],
    })) as {
      status: number;
      body: { routes: Array<{ id: string; spans: Array<{ los: string }> }> };
    };

    expect(status).toBe(200);
    expect(body.routes.find((r) => r.id === "r0")).toEqual({ id: "r0", spans: [] });
    const r1 = body.routes.find((r) => r.id === "r1");
    expect(r1).toBeDefined();
    if (!r1) throw new Error("expected route r1 in the response");
    expect(r1.spans.length).toBeGreaterThan(0);
  });
});
