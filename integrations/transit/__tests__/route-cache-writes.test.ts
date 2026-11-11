import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index";

const orchestrator = vi.hoisted(() => ({
  getStopTransfers: vi.fn(),
  getRoute: vi.fn(),
  getRouteStops: vi.fn(),
  getVehicleJourney: vi.fn(),
  enrichJourneyPlatforms: vi.fn(async (value: unknown) => value),
}));
vi.mock("../orchestrator", async (original) => ({
  ...(await original<object>()),
  createTransitOrchestrator: () => orchestrator,
}));

const result = <T>(data: T) => ({ data, attributions: [], freshness: {} });

function fixture() {
  const values = new Map<string, { value: unknown; ttl: number }>();
  const set = vi.fn();
  const ctx = createMockIntegrationContext({
    cache: {
      get: async () => null,
      set,
      del: async () => {},
      withCache: async (key, ttl, load, _signal, shouldCache) => {
        const hit = values.get(key);
        if (hit) return hit.value as never;
        const value = await load(new AbortController().signal);
        if (!shouldCache || shouldCache(value)) values.set(key, { value, ttl });
        return value;
      },
    },
  });
  setup(ctx);
  const call = async (path: string, req: unknown) => {
    let status = 200;
    let body: unknown;
    const reply = {
      status: (code: number) => {
        status = code;
        return reply;
      },
      header: () => reply,
      send: (value: unknown) => {
        body = value;
        return reply;
      },
    };
    const route = ctx.registered.routes.find((r) => r.method === "GET" && r.path === path);
    if (!route) throw new Error(`missing route ${path}`);
    await route.handler(req as never, reply as never);
    return { status, body };
  };
  return { values, set, call };
}

beforeEach(() => vi.clearAllMocks());

describe("transit upstream cache writes", () => {
  it("caches found routes, route stops, transfers and journeys through withCache", async () => {
    const f = fixture();
    orchestrator.getStopTransfers.mockResolvedValue(result([{ to: "b" }]));
    orchestrator.getRoute.mockResolvedValue(result({ id: "r1" }));
    orchestrator.getRouteStops.mockResolvedValue(result([{ id: "s1" }]));
    orchestrator.getVehicleJourney.mockResolvedValue(result({ id: "trip", stops: [] }));

    for (let round = 0; round < 2; round++) {
      await f.call("/stops/:id/transfers", { params: { id: "s1" }, query: {} });
      expect((await f.call("/routes/:id", { params: { id: "r1" }, query: {} })).status).toBe(200);
      await f.call("/routes/:id/stops", { params: { id: "r1" }, query: { hint_stop_id: "s1" } });
      await f.call("/vehicles/:id", { params: { id: "trip" }, query: {} });
    }

    for (const fn of [
      orchestrator.getStopTransfers,
      orchestrator.getRoute,
      orchestrator.getRouteStops,
      orchestrator.getVehicleJourney,
    ])
      expect(fn).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries([...f.values].map(([key, { ttl }]) => [key, ttl]))).toEqual({
      "stop-transfers:s1": 3600,
      "transit:route:r1": 3600,
      "transit:route-stops:r1:s1": 3600,
      'transit:vehicle-journey:["trip",[]]': 30,
    });
    expect(f.set).not.toHaveBeenCalled();
  });

  it("keeps misses out of the cache so a later answer is served", async () => {
    const f = fixture();
    orchestrator.getRoute.mockResolvedValue(result(null));
    orchestrator.getRouteStops.mockResolvedValue(result([]));
    orchestrator.getVehicleJourney.mockResolvedValue(result(null));

    expect((await f.call("/routes/:id", { params: { id: "r2" }, query: {} })).status).toBe(404);
    await f.call("/routes/:id/stops", { params: { id: "r2" }, query: {} });
    expect((await f.call("/vehicles/:id", { params: { id: "t2" }, query: {} })).status).toBe(404);

    expect(f.values.size).toBe(0);
    expect(f.set).not.toHaveBeenCalled();
  });
});
