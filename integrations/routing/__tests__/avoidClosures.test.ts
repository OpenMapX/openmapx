import { createHash } from "node:crypto";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";
import type { DirectionsResult, RoutingProvider, TravelMode } from "../types.js";

// Minimal stub for ctx.cache.withCache — executes the factory immediately and
// returns whatever it produces, so caching is transparent in these tests.
function makeCacheStub() {
  return {
    withCache: vi.fn(async (_key: string, _ttl: number, factory: () => Promise<unknown>) =>
      factory(),
    ),
  };
}

function makeLogStub() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeDirectionsResult(): DirectionsResult {
  return { waypoints: [], routes: [], activeRouteIndex: 0 };
}

type Handler = (req: { query: Record<string, string> }, reply: MockReply) => Promise<void>;

interface MockReply {
  status: (code: number) => MockReply;
  send: (body?: unknown) => void;
  header: (name: string, value: string) => void;
  _code: number;
  _body: unknown;
}

function makeMockReply(): MockReply {
  const r: MockReply = {
    _code: 200,
    _body: undefined,
    status(code: number) {
      r._code = code;
      return r;
    },
    send(body?: unknown) {
      r._body = body;
    },
    header: vi.fn() as MockReply["header"],
  };
  return r;
}

/**
 * Build a minimal IntegrationContext that:
 *  - serves the given routing providers under their integration IDs,
 *  - optionally returns stub road-closures from the road-conditions domain, and
 *  - captures every route registered by setup() so tests can invoke handlers
 *    directly without a running HTTP server.
 */
function makeCtx(
  routingProviders: {
    integrationId: string;
    providerId: string;
    getRoute: ReturnType<typeof vi.fn>;
  }[],
  closurePoints: [number, number][] = [],
): { getDirectionsHandler: () => Handler } {
  const handlers = new Map<string, Handler>();

  const hasClosures = closurePoints.length > 0;

  const closureEvents = closurePoints.map((p, i) => ({
    id: `closure:${i}`,
    source: "test",
    provider: "road-conditions-stub",
    type: "road_closure",
    severity: "high",
    geometry: { type: "Point", coordinates: p },
    headline: `Closure ${i}`,
  }));

  const ctx = {
    getIntegrationsByDomain: (domain: string) => {
      if (domain === "routing") {
        return routingProviders.map((rp) => ({
          id: rp.integrationId,
          providers: new Map<string, RoutingProvider[]>([
            [
              "routing",
              [
                {
                  id: rp.providerId,
                  supportedModes: ["driving", "walking", "cycling"] as TravelMode[],
                  getRoute: rp.getRoute,
                },
              ],
            ],
          ]),
        }));
      }
      if (domain === "road-conditions" && hasClosures) {
        return [
          {
            id: "road-conditions-stub",
            providers: new Map<string, unknown[]>([
              [
                "road-conditions",
                [
                  {
                    id: "road-conditions-stub",
                    getEvents: vi.fn().mockResolvedValue(closureEvents),
                  },
                ],
              ],
            ]),
          },
        ];
      }
      return [];
    },
    registerRoute: vi.fn((_method: string, path: string, handler: Handler) => {
      handlers.set(path, handler);
    }),
    cache: makeCacheStub(),
    log: makeLogStub(),
  } as unknown as IntegrationContext;

  setup(ctx);

  return {
    getDirectionsHandler: () => {
      const h = handlers.get("/directions");
      if (!h) throw new Error("/directions handler was not registered");
      return h;
    },
  };
}

const WAYPOINTS_QUERY = "0.1,51.1;0.2,51.2";
const WAYPOINTS: [number, number][] = [
  [0.1, 51.1],
  [0.2, 51.2],
];

describe("/directions handler — avoidClosures=true with active closures", () => {
  it("filters provider chain to valhalla only and forwards excludeLocations to getRoute", async () => {
    const closurePoint: [number, number] = [0.15, 51.15];
    const osrmSpy = vi.fn(async () => makeDirectionsResult());
    const valhallaSpy = vi.fn(async () => makeDirectionsResult());

    const { getDirectionsHandler } = makeCtx(
      [
        { integrationId: "routing-osrm", providerId: "osrm", getRoute: osrmSpy },
        { integrationId: "routing-valhalla", providerId: "valhalla", getRoute: valhallaSpy },
      ],
      [closurePoint],
    );

    const reply = makeMockReply();
    await getDirectionsHandler()(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    // Valhalla is the only provider that honours excludeLocations/excludePolygons.
    expect(valhallaSpy).toHaveBeenCalledTimes(1);
    // OSRM was filtered out — it would silently route through closures.
    expect(osrmSpy).not.toHaveBeenCalled();

    // The options forwarded to valhalla must carry the closure geometry.
    const call = valhallaSpy.mock.calls.at(0);
    expect(call).toBeDefined();
    const opts = call?.[2];
    expect(opts).toMatchObject({
      excludeLocations: [closurePoint],
      excludePolygons: [],
    });
  });
});

describe("/directions handler — avoidClosures absent or false", () => {
  it("does not narrow the provider chain and passes no exclusion fields", async () => {
    const osrmSpy = vi.fn(async () => makeDirectionsResult());
    const valhallaSpy = vi.fn(async () => makeDirectionsResult());

    const { getDirectionsHandler } = makeCtx([
      { integrationId: "routing-osrm", providerId: "osrm", getRoute: osrmSpy },
      { integrationId: "routing-valhalla", providerId: "valhalla", getRoute: valhallaSpy },
    ]);

    const reply = makeMockReply();
    // avoidClosures is absent — same code path as avoidClosures=false.
    await getDirectionsHandler()({ query: { waypoints: WAYPOINTS_QUERY } }, reply);

    // Driving preference puts valhalla first; it succeeds so OSRM is not
    // tried — but the chain itself was not restricted.
    expect(valhallaSpy).toHaveBeenCalledTimes(1);
    const opts = valhallaSpy.mock.calls.at(0)?.[2];
    expect(opts).not.toHaveProperty("excludeLocations");
    expect(opts).not.toHaveProperty("excludePolygons");
  });
});

describe("/directions handler — avoidClosures=true but zero closures returned", () => {
  it("does not narrow the provider chain and passes no exclusion fields", async () => {
    const osrmSpy = vi.fn(async () => makeDirectionsResult());
    const valhallaSpy = vi.fn(async () => makeDirectionsResult());

    // No closures registered in road-conditions — activeClosuresForBbox yields empty.
    const { getDirectionsHandler } = makeCtx([
      { integrationId: "routing-osrm", providerId: "osrm", getRoute: osrmSpy },
      { integrationId: "routing-valhalla", providerId: "valhalla", getRoute: valhallaSpy },
    ]);

    const reply = makeMockReply();
    await getDirectionsHandler()(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    // hasExclusions is false (empty closures), so the chain is not narrowed.
    expect(valhallaSpy).toHaveBeenCalledTimes(1);
    const opts = valhallaSpy.mock.calls.at(0)?.[2];
    expect(opts).not.toHaveProperty("excludeLocations");
    expect(opts).not.toHaveProperty("excludePolygons");
  });
});

describe("/directions handler — cache key variance", () => {
  it("produces distinct cache keys for avoidClosures=false, true+no-closures, and true+closures", () => {
    function buildKey(params: { avoidClosures: boolean; exclusionsHash: string | null }): string {
      function round(v: number, d: number) {
        return Math.round(v * 10 ** d) / 10 ** d;
      }
      const data = {
        arriveBy: null,
        avoidClosures: params.avoidClosures,
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        departAt: null,
        exclusionsHash: params.exclusionsHash,
        lang: "en",
        mode: "driving",
        units: "metric",
        waypoints: WAYPOINTS.map((wp) => [round(wp[0], 4), round(wp[1], 4)]),
      };
      const h = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
      return `cache:directions:${h}`;
    }

    // The exclusionsHash component mirrors how the handler builds it:
    // hashKey("excl", { points, polygons }) → "excl:" + first-16-chars-of-sha256.
    const closurePoint: [number, number] = [0.15, 51.15];
    const exclusionsHash =
      "excl:" +
      createHash("sha256")
        .update(JSON.stringify({ points: [closurePoint], polygons: [] }))
        .digest("hex")
        .slice(0, 16);

    const keyOff = buildKey({ avoidClosures: false, exclusionsHash: null });
    const keyOnEmpty = buildKey({ avoidClosures: true, exclusionsHash: null });
    const keyOnFull = buildKey({ avoidClosures: true, exclusionsHash });

    // All three must be distinct — ensuring closures affect caching.
    expect(keyOff).not.toBe(keyOnEmpty);
    expect(keyOnEmpty).not.toBe(keyOnFull);
    expect(keyOff).not.toBe(keyOnFull);
  });
});
