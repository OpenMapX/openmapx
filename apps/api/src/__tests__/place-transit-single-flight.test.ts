import type { IntegrationContext } from "@openmapx/integration-framework";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../../../../integrations/transit/orchestrator";
import { createPlaceTransit } from "../../../../integrations/transit/place-transit";
import { emptyResult } from "../../../../integrations/transit/result-merge";

const { values, redisMock } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    redisMock: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        values.set(key, value);
      }),
      del: vi.fn(async (key: string) => values.delete(key)),
      eval: vi.fn(
        async (
          _script: string,
          _keyCount: number,
          epochKey: string,
          key: string,
          _leasesKey: string,
          epoch: string,
          serialized: string,
        ) => {
          if ((values.get(epochKey) ?? "0") !== epoch) return 0;
          values.set(key, serialized);
          return 1;
        },
      ),
    },
  };
});
vi.mock("../redis", () => ({ redis: redisMock }));

import { createCacheClient } from "../integration-clients";

beforeEach(() => {
  values.clear();
  vi.clearAllMocks();
});

function setup(searchByNameRaw: TransitOrchestrator["searchByNameRaw"]) {
  const downstream = {
    getRoutesForStop: vi.fn(async () => emptyResult([])),
    getDepartures: vi.fn(async () => emptyResult([])),
    getStopAlerts: vi.fn(async () => emptyResult([])),
    getFacilities: vi.fn(async () => emptyResult([])),
  };
  const ctx = { cache: createCacheClient("transit-perf-test") } as IntegrationContext;
  const orchestrator = {
    searchByNameRaw,
    collectProviders: () => [],
    ...downstream,
  } as unknown as TransitOrchestrator;
  return { transit: createPlaceTransit(ctx, orchestrator), downstream };
}

describe("station linked-stop single-flight", () => {
  it("shares cold discovery across four panel requests and retains the cached envelope", async () => {
    const gate = Promise.withResolvers<void>();
    const stops: TransitStop[] = [
      { id: "ms:test", name: "Central", lat: 50, lng: 7, provider: "ms", modes: [] },
    ];
    const discovery = {
      ...emptyResult(stops),
      attributions: [
        { sourceId: "test-feed", name: "Test feed", notes: "Original timetable notice" },
      ],
    };
    const search = vi.fn<TransitOrchestrator["searchByNameRaw"]>(async () => {
      await gate.promise;
      return discovery;
    });
    const { transit, downstream } = setup(search);
    const pending = Promise.all([
      transit.getMergedRoutes(50, 7, "Central"),
      transit.getMergedDepartures(50, 7, "Central", 30),
      transit.getMergedAlerts(50, 7, "Central"),
      transit.getMergedFacilities(50, 7, "Central"),
    ]);
    try {
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      gate.resolve();
      const panels = await pending;
      expect(panels.map((result) => result.attributions)).toEqual([[], [], [], []]);
      expect(search).toHaveBeenCalledTimes(1);
      for (const fn of Object.values(downstream)) expect(fn).toHaveBeenCalledTimes(1);
      const retained = await transit.getLinkedStops(50, 7, "Central");
      expect(retained).toEqual({
        ...discovery,
        data: stops.map((stop) => ({ ...stop, contributors: discovery.attributions })),
      });
      expect(stops[0]).not.toHaveProperty("contributors");
      const cached = [...values.entries()].find(([key]) => key.includes("place-stops:"));
      expect(cached).toBeDefined();
      expect(JSON.parse(cached?.[1] ?? "null").stops[0].contributors).toEqual(
        discovery.attributions,
      );
      expect(search).toHaveBeenCalledTimes(1);
      expect([...values.keys()].filter((key) => key.includes("place-stops:"))).toHaveLength(1);
    } finally {
      gate.resolve();
      await pending;
    }
  });

  it("releases failed discovery so a later call can retry, then caches an empty result", async () => {
    const gate = Promise.withResolvers<void>();
    const search = vi.fn<TransitOrchestrator["searchByNameRaw"]>(async () => {
      await gate.promise;
      throw new Error("discovery unavailable");
    });
    const { transit } = setup(search);
    const first = transit.getLinkedStops(50, 7, "Central");
    const second = transit.getLinkedStops(50, 7, "Central");
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    gate.resolve();
    const failed = await settled;
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(values.size).toBe(0);

    const empty = emptyResult<TransitStop[]>([]);
    search.mockImplementation(async () => empty);
    expect(await transit.getLinkedStops(50, 7, "Central")).toEqual(empty);
    expect(await transit.getLinkedStops(50, 7, "Central")).toEqual(empty);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
