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
  const route = {
    distance: 300_000,
    duration: 12_000,
    geometry: Array.from({ length: 7 }, (_, i) => [i * 0.45, 50]) as [number, number][],
    legs: [],
    steps: [],
    mode: "driving" as TravelMode,
  };
  return { waypoints: [], routes: [route], activeRouteIndex: 0 };
}

type Handler = (req: { body?: Record<string, unknown> | null }, reply: MockReply) => Promise<void>;

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
 * Build a minimal IntegrationContext that serves a valhalla routing provider
 * (getRoute/getMatrix stubbed) and an ev-charging data-source provider whose
 * searchStations returns no chargers, then captures every route registered by
 * setup() so tests can invoke the `/directions/ev` handler directly without a
 * running HTTP server.
 */
function makeCtx(): { getEvDirectionsHandler: () => Handler } {
  const handlers = new Map<string, Handler>();

  const getRoute = vi.fn(async () => makeDirectionsResult());
  const getMatrix = vi.fn(async (s: unknown[], t: unknown[]) =>
    s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
  );
  const searchStations = vi.fn().mockResolvedValue([]);

  const ctx = {
    getIntegrationsByDomain: (domain: string) => {
      if (domain === "routing") {
        return [
          {
            id: "valhalla",
            providers: new Map<string, RoutingProvider[]>([
              [
                "routing",
                [
                  {
                    id: "valhalla",
                    supportedModes: ["driving", "walking", "cycling"] as TravelMode[],
                    getRoute,
                    getMatrix,
                  },
                ],
              ],
            ]),
          },
        ];
      }
      if (domain === "data-source") {
        return [
          {
            id: "ev-charging",
            providers: new Map<string, unknown[]>([["data-source", [{ searchStations }]]]),
          },
        ];
      }
      return [];
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    registerRoute: vi.fn((_method: string, path: string, handler: Handler) => {
      handlers.set(path, handler);
    }),
    cache: makeCacheStub(),
    log: makeLogStub(),
  } as unknown as IntegrationContext;

  setup(ctx);

  return {
    getEvDirectionsHandler: () => {
      const h = handlers.get("/directions/ev");
      if (!h) throw new Error("/directions/ev handler was not registered");
      return h as Handler;
    },
  };
}

describe("POST /directions/ev — input hardening", () => {
  it("400s when waypoints are missing", async () => {
    const { getEvDirectionsHandler } = makeCtx();
    const reply = makeMockReply();
    await getEvDirectionsHandler()({ body: {} }, reply);
    expect(reply._code).toBe(400);
  });

  it("400s when socStartPct is out of range", async () => {
    const { getEvDirectionsHandler } = makeCtx();
    const reply = makeMockReply();
    await getEvDirectionsHandler()(
      {
        body: {
          waypoints: [
            [0, 50],
            [2.7, 50],
          ],
          vehicleId: "volkswagen:id_4:2024:id_4",
          socStartPct: 150,
        },
      },
      reply,
    );
    expect(reply._code).toBe(400);
  });

  it("400s when socArrivalMinPct is non-numeric", async () => {
    const { getEvDirectionsHandler } = makeCtx();
    const reply = makeMockReply();
    await getEvDirectionsHandler()(
      {
        body: {
          waypoints: [
            [0, 50],
            [2.7, 50],
          ],
          vehicleId: "volkswagen:id_4:2024:id_4",
          socStartPct: 80,
          socArrivalMinPct: "abc",
        },
      },
      reply,
    );
    expect(reply._code).toBe(400);
  });

  it("400s when the inline vehicle spec is malformed", async () => {
    const { getEvDirectionsHandler } = makeCtx();
    const reply = makeMockReply();
    await getEvDirectionsHandler()(
      {
        body: {
          waypoints: [
            [0, 50],
            [2.7, 50],
          ],
          vehicle: { batteryKwh: 0 },
          socStartPct: 80,
        },
      },
      reply,
    );
    expect(reply._code).toBe(400);
  });

  it("does not 400 on a valid body", async () => {
    const { getEvDirectionsHandler } = makeCtx();
    const reply = makeMockReply();
    await getEvDirectionsHandler()(
      {
        body: {
          waypoints: [
            [0, 50],
            [2.7, 50],
          ],
          vehicleId: "volkswagen:id_4:2024:id_4",
          socStartPct: 80,
        },
      },
      reply,
    );
    expect(reply._code).toBeLessThan(400);
  });
});
