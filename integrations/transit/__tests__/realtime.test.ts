import type {
  IntegrationContext,
  RealtimeProvider,
  TripUpdate,
} from "@openmapx/integration-framework";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { __testing, enrichDeparturesWithRealtime } from "../realtime.js";

const { applyDelta, isAlreadyRealtime, providerMatches } = __testing;

function fresh(extra?: Partial<Freshness>): Freshness {
  return {
    fetchedAt: "2026-05-22T08:00:00Z",
    hasRealtimeData: false,
    isStale: false,
    ...extra,
  };
}

function dep(partial: Partial<Departure> & { tripId: string }): Departure {
  return {
    tripId: partial.tripId,
    route: {
      id: "ms:route-1",
      shortName: "S1",
      longName: "",
      mode: "rail",
      color: undefined,
    },
    headsign: "Berlin Hbf",
    scheduledAt: "2026-05-22T08:00:00Z",
    ...partial,
  };
}

function makeProvider(overrides: Partial<RealtimeProvider> = {}): RealtimeProvider {
  return {
    id: "live-transit-motis",
    coverage: { all: true },
    priority: 10,
    attribution: [{ sourceId: "motis-rt", name: "MOTIS GTFS-RT Pass-through" }],
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      tripUpdates: true,
    },
    ...overrides,
  };
}

function makeCtx(providers: RealtimeProvider[]): IntegrationContext {
  return {
    getIntegrationsByDomain: (domain: string) => {
      if (domain !== "live-transit") return [];
      return [
        {
          providers: new Map([["live-transit", providers]]),
        },
      ];
    },
  } as unknown as IntegrationContext;
}

const timed = async <T>(
  _id: string,
  _method: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
};

describe("enrichDeparturesWithRealtime", () => {
  it("returns the base result unchanged when no realtime providers match", async () => {
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [{ sourceId: "transitous", name: "Transitous" }],
      freshness: fresh(),
    };
    const ctx = makeCtx([]);
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, {
      stopId: "ms:DE:8000105",
    });
    expect(out).toBe(base);
  });

  it("skips departures that already carry realtime fields", async () => {
    const getTripUpdate = vi.fn();
    const provider = makeProvider({ getTripUpdate });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1", expectedAt: "2026-05-22T08:02:00Z", delaySeconds: 120 })],
      attributions: [],
      freshness: fresh({ hasRealtimeData: true }),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, {
      stopId: "ms:DE:8000105",
    });
    expect(out).toBe(base);
    expect(getTripUpdate).not.toHaveBeenCalled();
  });

  it("makes zero enrichment calls for MOTIS realtime-merged on-time departures", async () => {
    const getTripUpdate = vi.fn();
    const getTripUpdates = vi.fn();
    const provider = makeProvider({ getTripUpdate, getTripUpdates });
    const base: MobilityResult<Departure[]> = {
      data: Array.from({ length: 10 }, (_, index) =>
        dep({
          tripId: `ms:trip-${index}`,
          provenance: {
            baselineSource: "motis",
            instance: "local",
            datasetEpoch: "epoch-1",
            realtimeCompleteness: "merged",
            observedAt: "2026-05-22T08:00:00Z",
          },
        }),
      ),
      attributions: [],
      freshness: fresh({ hasRealtimeData: true }),
    };

    const out = await enrichDeparturesWithRealtime({ ctx: makeCtx([provider]), timed }, base, {
      stopId: "ms:s",
    });

    expect(out).toBe(base);
    expect(getTripUpdate).not.toHaveBeenCalled();
    expect(getTripUpdates).not.toHaveBeenCalled();
  });

  it("deduplicates duplicate trip identities into one batch lookup", async () => {
    const getTripUpdates = vi.fn().mockResolvedValue({
      data: { "ms:trip-1": { tripId: "ms:trip-1", delaySeconds: 60 } },
      attributions: [],
      freshness: fresh({ hasRealtimeData: true }),
    });
    const provider = makeProvider({ getTripUpdate: undefined, getTripUpdates });
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" }), dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };

    const out = await enrichDeparturesWithRealtime({ ctx: makeCtx([provider]), timed }, base, {
      stopId: "ms:s",
    });

    expect(getTripUpdates).toHaveBeenCalledOnce();
    expect(getTripUpdates).toHaveBeenCalledWith(["ms:trip-1"], "ms:s");
    expect(out.data.every((departure) => departure.delaySeconds === 60)).toBe(true);
  });

  it("bounds non-batch enrichment concurrency to four calls", async () => {
    let active = 0;
    let maxActive = 0;
    const getTripUpdate = vi.fn(async (tripId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        data: { tripId, delaySeconds: 30 },
        attributions: [],
        freshness: fresh({ hasRealtimeData: true }),
      };
    });
    const provider = makeProvider({ getTripUpdate });
    const base: MobilityResult<Departure[]> = {
      data: Array.from({ length: 10 }, (_, index) => dep({ tripId: `ms:trip-${index}` })),
      attributions: [],
      freshness: fresh(),
    };

    await enrichDeparturesWithRealtime({ ctx: makeCtx([provider]), timed }, base, {
      stopId: "ms:s",
    });

    expect(getTripUpdate).toHaveBeenCalledTimes(10);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("applies a TripUpdate delta and flips freshness.hasRealtimeData", async () => {
    const delta: TripUpdate = {
      tripId: "ms:trip-1",
      expectedAt: "2026-05-22T08:02:30Z",
      delaySeconds: 150,
      platform: "7",
    };
    const provider = makeProvider({
      getTripUpdate: vi.fn().mockResolvedValue({
        data: delta,
        attributions: [{ sourceId: "motis-rt", name: "MOTIS GTFS-RT Pass-through" }],
        freshness: fresh({ hasRealtimeData: true }),
      }),
    });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [{ sourceId: "transitous", name: "Transitous" }],
      freshness: fresh(),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, {
      stopId: "ms:DE:8000105",
    });
    expect(out.data[0]).toMatchObject({
      tripId: "ms:trip-1",
      expectedAt: "2026-05-22T08:02:30Z",
      delaySeconds: 150,
      platform: "7",
    });
    expect(out.freshness.hasRealtimeData).toBe(true);
    expect(out.attributions.map((a) => a.sourceId).sort()).toEqual(["motis-rt", "transitous"]);
  });

  it("propagates a cancellation delta", async () => {
    const provider = makeProvider({
      getTripUpdate: vi.fn().mockResolvedValue({
        data: { tripId: "ms:trip-1", canceled: true } satisfies TripUpdate,
        attributions: [],
        freshness: fresh({ hasRealtimeData: true }),
      }),
    });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, {
      stopId: "ms:DE:8000105",
    });
    expect(out.data[0].canceled).toBe(true);
    expect(out.freshness.hasRealtimeData).toBe(true);
  });

  it("stops at the first provider that produces a useful delta", async () => {
    const winner = vi.fn().mockResolvedValue({
      data: { tripId: "ms:trip-1", delaySeconds: 60 } satisfies TripUpdate,
      attributions: [],
      freshness: fresh({ hasRealtimeData: true }),
    });
    const loser = vi.fn().mockResolvedValue({
      data: null,
      attributions: [],
      freshness: fresh(),
    });
    const p1 = makeProvider({ id: "rt-a", priority: 1, getTripUpdate: winner });
    const p2 = makeProvider({ id: "rt-b", priority: 2, getTripUpdate: loser });
    const ctx = makeCtx([p2, p1]); // unsorted on purpose; helper must sort by priority

    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };
    await enrichDeparturesWithRealtime({ ctx, timed }, base, { stopId: "ms:s" });
    expect(winner).toHaveBeenCalledOnce();
    expect(loser).not.toHaveBeenCalled();
  });

  it("ignores providers without tripUpdates capability", async () => {
    const noop = vi.fn();
    const provider = makeProvider({
      capabilities: {
        vehiclePositions: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
      getTripUpdate: noop,
    });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, { stopId: "ms:s" });
    expect(out).toBe(base);
    expect(noop).not.toHaveBeenCalled();
  });

  it("skips bbox-scoped providers when no bbox hint is given", async () => {
    const getTripUpdate = vi.fn();
    const provider = makeProvider({
      coverage: { bbox: [13, 52, 14, 53] },
      getTripUpdate,
    });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, { stopId: "ms:s" });
    expect(out).toBe(base);
    expect(getTripUpdate).not.toHaveBeenCalled();
  });

  it("ignores bbox-scoped providers whose coverage does not overlap the hint", async () => {
    const getTripUpdate = vi.fn();
    const provider = makeProvider({
      coverage: { bbox: [13, 52, 14, 53] }, // Berlin
      getTripUpdate,
    });
    const ctx = makeCtx([provider]);
    const base: MobilityResult<Departure[]> = {
      data: [dep({ tripId: "ms:trip-1" })],
      attributions: [],
      freshness: fresh(),
    };
    const out = await enrichDeparturesWithRealtime({ ctx, timed }, base, {
      stopId: "ms:s",
      bbox: [10, 47, 11, 48], // Munich-ish, no overlap
    });
    expect(out).toBe(base);
    expect(getTripUpdate).not.toHaveBeenCalled();
  });
});

describe("realtime internals", () => {
  it("applyDelta returns false when nothing changes", () => {
    const d = dep({ tripId: "ms:trip", expectedAt: "2026-05-22T08:02:00Z", delaySeconds: 120 });
    const changed = applyDelta(d, {
      tripId: "ms:trip",
      expectedAt: "2026-05-22T08:02:00Z",
      delaySeconds: 120,
    });
    expect(changed).toBe(false);
  });

  it("isAlreadyRealtime detects each realtime field independently", () => {
    expect(isAlreadyRealtime(dep({ tripId: "x" }))).toBe(false);
    expect(isAlreadyRealtime(dep({ tripId: "x", expectedAt: "now" }))).toBe(true);
    expect(isAlreadyRealtime(dep({ tripId: "x", delaySeconds: 0 }))).toBe(true);
    expect(isAlreadyRealtime(dep({ tripId: "x", canceled: true }))).toBe(true);
  });

  it("providerMatches respects coverage and capabilities", () => {
    const stub = vi.fn();
    const allMatch = makeProvider({ getTripUpdate: stub });
    const bboxMatch = makeProvider({ coverage: { bbox: [10, 50, 11, 51] }, getTripUpdate: stub });
    const noCap = makeProvider({
      getTripUpdate: stub,
      capabilities: {
        vehiclePositions: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        tripUpdates: false,
      },
    });
    const noMethod = makeProvider({ getTripUpdate: undefined });

    expect(providerMatches(allMatch, undefined)).toBe(true);
    expect(providerMatches(bboxMatch, undefined)).toBe(false);
    expect(providerMatches(bboxMatch, [10.5, 50.5, 10.6, 50.6])).toBe(true);
    expect(providerMatches(bboxMatch, [20, 60, 21, 61])).toBe(false);
    expect(providerMatches(noCap, undefined)).toBe(false);
    expect(providerMatches(noMethod, undefined)).toBe(false);
  });
});
