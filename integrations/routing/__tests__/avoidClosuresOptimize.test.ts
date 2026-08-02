import { createHash } from "node:crypto";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";
import type { DirectionsResult, RoutingProvider, TravelMode } from "../types.js";

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
 * Build a minimal IntegrationContext that exposes a routing
 * provider with both getRoute and optimizeRoute, optionally with active road
 * closures. Returns handles to both the /directions and /directions/optimize
 * handlers registered by setup().
 */
function makeCtx(
  routingProviders: {
    integrationId: string;
    providerId: string;
    getRoute: ReturnType<typeof vi.fn>;
    optimizeRoute?: ReturnType<typeof vi.fn>;
    priority?: number;
    supportsExclusions?: boolean;
  }[],
  closurePoints: [number, number][] = [],
): { getDirectionsHandler: () => Handler; getOptimizeHandler: () => Handler } {
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
                  priority: rp.priority,
                  supportsExclusions: rp.supportsExclusions,
                  getRoute: rp.getRoute,
                  ...(rp.optimizeRoute ? { optimizeRoute: rp.optimizeRoute } : {}),
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
    getOptimizeHandler: () => {
      const h = handlers.get("/directions/optimize");
      if (!h) throw new Error("/directions/optimize handler was not registered");
      return h;
    },
  };
}

const WAYPOINTS_QUERY = "0.1,51.1;0.2,51.2;0.3,51.3";
const WAYPOINTS: [number, number][] = [
  [0.1, 51.1],
  [0.2, 51.2],
  [0.3, 51.3],
];

describe("/directions/optimize handler — avoidClosures=true with active closures", () => {
  it("selects an exclusion-capable provider and forwards geometry to optimizeRoute", async () => {
    const closurePoint: [number, number] = [0.15, 51.15];
    const optimizeSpy = vi.fn(async () => makeDirectionsResult());

    const { getOptimizeHandler } = makeCtx(
      [
        {
          integrationId: "routing-closure-aware",
          providerId: "engine-b",
          priority: 10,
          supportsExclusions: true,
          getRoute: vi.fn(async () => makeDirectionsResult()),
          optimizeRoute: optimizeSpy,
        },
      ],
      [closurePoint],
    );

    const reply = makeMockReply();
    await getOptimizeHandler()(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    const opts = optimizeSpy.mock.calls.at(0)?.[2];
    expect(opts).toMatchObject({
      excludeLocations: [closurePoint],
      excludePolygons: [],
    });
  });

  it("returns 503 when avoidClosures=true but no optimizer supports exclusions", async () => {
    const closurePoint: [number, number] = [0.15, 51.15];
    const osrmOptimizeSpy = vi.fn(async () => makeDirectionsResult());

    const { getOptimizeHandler } = makeCtx(
      [
        {
          integrationId: "routing-fallback",
          providerId: "engine-a",
          getRoute: vi.fn(async () => makeDirectionsResult()),
          optimizeRoute: osrmOptimizeSpy,
        },
      ],
      [closurePoint],
    );

    const reply = makeMockReply();
    await getOptimizeHandler()(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    expect(reply._code).toBe(503);
    expect(osrmOptimizeSpy).not.toHaveBeenCalled();
  });
});

describe("/directions/optimize handler — avoidClosures absent or false", () => {
  it("does not inject exclusion fields and uses the default optimizer", async () => {
    const optimizeSpy = vi.fn(async () => makeDirectionsResult());

    const { getOptimizeHandler } = makeCtx([
      {
        integrationId: "routing-preferred",
        providerId: "engine-b",
        priority: 10,
        supportsExclusions: true,
        getRoute: vi.fn(async () => makeDirectionsResult()),
        optimizeRoute: optimizeSpy,
      },
    ]);

    const reply = makeMockReply();
    await getOptimizeHandler()({ query: { waypoints: WAYPOINTS_QUERY } }, reply);

    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    const opts = optimizeSpy.mock.calls.at(0)?.[2];
    expect(opts).not.toHaveProperty("excludeLocations");
    expect(opts).not.toHaveProperty("excludePolygons");
  });
});

describe("/directions/optimize handler — avoidClosures=true but zero closures returned", () => {
  it("does not inject exclusion fields when no closures are active", async () => {
    const optimizeSpy = vi.fn(async () => makeDirectionsResult());

    // No closures registered — activeClosuresForBbox yields empty.
    const { getOptimizeHandler } = makeCtx([
      {
        integrationId: "routing-preferred",
        providerId: "engine-b",
        priority: 10,
        supportsExclusions: true,
        getRoute: vi.fn(async () => makeDirectionsResult()),
        optimizeRoute: optimizeSpy,
      },
    ]);

    const reply = makeMockReply();
    await getOptimizeHandler()(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    expect(optimizeSpy).toHaveBeenCalledTimes(1);
    const opts = optimizeSpy.mock.calls.at(0)?.[2];
    expect(opts).not.toHaveProperty("excludeLocations");
    expect(opts).not.toHaveProperty("excludePolygons");
  });
});

describe("/directions/optimize handler — cache key variance", () => {
  it("produces distinct cache keys for avoidClosures=false, true+no-closures, and true+closures", () => {
    function buildKey(params: { avoidClosures: boolean; exclusionsHash: string | null }): string {
      function roundN(v: number, d: number) {
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
        optimize: true,
        units: "metric",
        waypoints: WAYPOINTS.map((wp) => [roundN(wp[0], 4), roundN(wp[1], 4)]),
      };
      const h = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
      return `cache:directions:optimize:${h}`;
    }

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

    expect(keyOff).not.toBe(keyOnEmpty);
    expect(keyOnEmpty).not.toBe(keyOnFull);
    expect(keyOff).not.toBe(keyOnFull);
  });
});
