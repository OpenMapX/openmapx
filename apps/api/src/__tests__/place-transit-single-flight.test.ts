import type { IntegrationContext } from "@openmapx/integration-framework";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../../../../integrations/transit/orchestrator";
import { createPlaceTransit } from "../../../../integrations/transit/place-transit";
import { emptyResult } from "../../../../integrations/transit/result-merge";

const { values, ttls, redisMock } = vi.hoisted(() => {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    values,
    ttls,
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
          ttlSeconds: number,
        ) => {
          if ((values.get(epochKey) ?? "0") !== epoch) return 0;
          values.set(key, serialized);
          ttls.set(key, ttlSeconds);
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
  ttls.clear();
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

describe("partial station discovery", () => {
  const stops: TransitStop[] = [
    { id: "ms:test", name: "Central", lat: 50, lng: 7, provider: "ms", modes: [] },
  ];
  const partial = {
    ...emptyResult(stops),
    freshness: { ...emptyResult(stops).freshness, isPartial: true },
  };
  const keysWith = (fragment: string) => [...values.keys()].filter((k) => k.includes(fragment));

  it("keeps a partial discovery for a minute, outside the long-lived link cache", async () => {
    const search = vi.fn<TransitOrchestrator["searchByNameRaw"]>(async () => partial);
    const { transit } = setup(search);

    const first = await transit.getLinkedStops(50, 7, "Central");
    const second = await transit.getLinkedStops(50, 7, "Central");

    expect(first.freshness.isPartial).toBe(true);
    expect(second).toEqual(first);
    expect(search).toHaveBeenCalledTimes(1);
    expect(keysWith("place-stops:")).toEqual([]);
    const [retryKey] = keysWith("place-stops-partial:");
    expect(ttls.get(retryKey)).toBe(60);
  });

  it("replaces an expired partial discovery with a complete one cached for a day", async () => {
    const search = vi.fn<TransitOrchestrator["searchByNameRaw"]>(async () => partial);
    const { transit } = setup(search);
    await transit.getLinkedStops(50, 7, "Central");
    for (const key of keysWith("place-stops-partial:")) values.delete(key);

    const complete = emptyResult(stops);
    search.mockImplementation(async () => complete);
    const recovered = await transit.getLinkedStops(50, 7, "Central");

    expect(recovered.freshness.isPartial).toBeUndefined();
    expect(recovered.data.map((stop) => stop.id)).toEqual(["ms:test"]);
    const [linkKey] = keysWith("place-stops:");
    expect(ttls.get(linkKey)).toBeGreaterThanOrEqual(86_400 * 0.9);
  });

  it("caches panels derived from a partial discovery no longer than the discovery", async () => {
    const search = vi.fn<TransitOrchestrator["searchByNameRaw"]>(async () => partial);
    const { transit } = setup(search);

    const routes = await transit.getMergedRoutes(50, 7, "Central");
    const facilities = await transit.getMergedFacilities(50, 7, "Central");

    expect(routes.freshness.isPartial).toBe(true);
    expect(facilities.freshness.isPartial).toBe(true);
    for (const fragment of ["place-routes:", "place-facilities:"]) {
      const [key] = keysWith(fragment);
      expect(ttls.get(key)).toBe(60);
    }
  });
});
