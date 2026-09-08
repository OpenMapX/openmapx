import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The cron module reaches drizzle at import time (module-level pool) and the
// ops agent from a few handlers. Neither is involved in the live-traffic
// cycle, so stub both rather than stand up a database.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../ops-client.js", () => ({
  runOpsOperation: vi.fn(async () => ({ changed: true })),
}));

import { type CronSetupOptions, setupCron } from "../cron.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";
import type { WriteLiveTrafficDeps, WriteLiveTrafficResult } from "../jobs/traffic/write-live.js";

const OPEN_CONDITIONS_URL = "http://openconditions-ingest:8080";
const HEADER_ONLY_CSV = "way_id,dir,current_kph,free_flow_kph,los\n";

/** One exact, feed-origin closure bound to way 10 in the forward direction. */
function closureFeed(): string {
  return JSON.stringify({
    resolver_version: "r1",
    conditions: [
      {
        id: "a:1",
        type: "road_closure",
        road_state: "closed",
        origin_kind: "feed",
        routing_eligible: true,
        binding: { status: "exact" },
        segments: [{ way_id: 10, dir: "f", start_fraction: 0, end_fraction: 1, geometry: null }],
      },
    ],
  });
}

/** The same closure plus a second one, `a:2`, bound to way 20. */
function twoClosureFeed(): string {
  const first = JSON.parse(closureFeed()) as { conditions: unknown[] };
  first.conditions.push({
    id: "a:2",
    type: "road_closure",
    road_state: "closed",
    origin_kind: "feed",
    routing_eligible: true,
    binding: { status: "exact" },
    segments: [{ way_id: 20, dir: "f", start_fraction: 0, end_fraction: 1, geometry: null }],
  });
  return JSON.stringify(first);
}

function waysToEdgesWithWay10(): Map<number, WayEdge[]> {
  return new Map([[10, [{ forward: true, level: 0, tile: 1, index: 2 }]]]);
}

/** The same closure as `closureFeed`, but with the occupied geometry a trace needs. */
function closureFeedWithGeometry(): string {
  return JSON.stringify({
    resolver_version: "r1",
    conditions: [
      {
        id: "a:1",
        type: "road_closure",
        road_state: "closed",
        origin_kind: "feed",
        routing_eligible: true,
        binding: { status: "exact" },
        segments: [
          {
            way_id: 10,
            dir: "f",
            start_fraction: 0.5,
            end_fraction: 1,
            geometry: {
              type: "LineString",
              coordinates: [
                [6.81, 51.2],
                [6.82, 51.2],
              ],
            },
          },
        ],
      },
    ],
  });
}

/** Way 10 runs over two forward edges, so a trace can narrow the closure to one of them. */
function waysToEdgesWithTwoForwardEdges(): Map<number, WayEdge[]> {
  return new Map([
    [
      10,
      [
        { forward: true, level: 0, tile: 1, index: 5 },
        { forward: false, level: 0, tile: 1, index: 6 },
        { forward: true, level: 0, tile: 1, index: 7 },
      ],
    ],
  ]);
}

async function tempCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "traffic-live-span-cache-")), "span-edges-cache.json");
}

/**
 * A writer that applied every override it was handed. The cron reads the
 * applied set off THIS result, so each test states what the writer managed to
 * put on disk rather than what the merge asked for.
 */
function writeResult(deps: WriteLiveTrafficDeps): WriteLiveTrafficResult {
  const requested = [...(deps.overrides?.values() ?? [])].map((o) => o.observationId);
  return {
    written: 1,
    matched: 0,
    total: 0,
    outOfBounds: 0,
    closedEdges: 1,
    cappedEdges: 0,
    overridesUnresolved: 0,
    appliedObservationIds: [...new Set(requested)].sort(),
  };
}

interface Seams {
  fetchConditionsJson?: () => Promise<string>;
  loadWaysToEdges?: () => Promise<Map<number, WayEdge[]>>;
  writeLiveTraffic?: (deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>;
  trafficConditionsStaleMs?: number;
  getCoveredWayIds?: CronSetupOptions["getCoveredWayIds"];
  refreshWaysToEdges?: CronSetupOptions["refreshWaysToEdges"];
  traceSpanEdges?: CronSetupOptions["traceSpanEdges"];
  spanEdgeCachePath?: string;
  logger?: CronSetupOptions["logger"];
}

let cachePathCounter = 0;

function setupCronWithSeams(seams: Seams) {
  return setupCron({
    dataDir: "/tmp/openmapx-traffic-live-conditions",
    repoRoot: "/tmp/nope",
    countries: [],
    store: {} as never,
    singleFlight: {} as never,
    logger: seams.logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    // Every other schedule stays off so the only clock this suite moves is the
    // conditions staleness window.
    syncCronExpression: "disabled",
    feedProxyReloadCronExpression: "disabled",
    stalenessCheckCronExpression: "disabled",
    trafficExtractCronExpression: "disabled",
    trafficLiveCronExpression: "disabled",
    trafficPredictedCronExpression: "disabled",
    openConditionsUrl: OPEN_CONDITIONS_URL,
    trafficTarPath: "/data/osm/traffic.tar",
    fetchLiveTrafficCsv: async () => HEADER_ONLY_CSV,
    fetchConditionsJson: seams.fetchConditionsJson ?? (async () => closureFeed()),
    loadWaysToEdges: seams.loadWaysToEdges ?? (async () => waysToEdgesWithWay10()),
    writeLiveTraffic: seams.writeLiveTraffic ?? (async (deps) => writeResult(deps)),
    trafficConditionsStaleMs: seams.trafficConditionsStaleMs,
    getCoveredWayIds: seams.getCoveredWayIds,
    refreshWaysToEdges: seams.refreshWaysToEdges,
    traceSpanEdges: seams.traceSpanEdges,
    // Never the real `<dataDir>/traffic` path: each cron gets its own scratch
    // file unless a test deliberately shares one.
    spanEdgeCachePath:
      seams.spanEdgeCachePath ??
      join(tmpdir(), "openmapx-span-edge-cache-tests", `${process.pid}-${cachePathCounter++}.json`),
  });
}

/** Lets a `void`-fired background refresh settle before assertions. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("traffic-live conditions merge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes closure overrides to the writer and exposes the applied set", async () => {
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({ writeLiveTraffic: writeLive });

    await handles.runTrafficLiveNow();

    const call = writeLive.mock.calls[0]?.[0];
    expect(call?.overrides?.get("0:1:2")).toMatchObject({ closed: true, observationId: "a:1" });

    const applied = handles.getTrafficConditionsApplied();
    expect(applied.observationIds).toEqual(["a:1"]);
    expect(applied.writtenAt).not.toBeNull();
    expect(applied.resolverVersion).toBe("r1");

    handles.stop();
  });

  it("keeps the last good conditions for up to TRAFFIC_CONDITIONS_STALE_MS, then drops them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));

    const staleMs = 600_000;
    let failing = false;
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      writeLiveTraffic: writeLive,
      trafficConditionsStaleMs: staleMs,
      fetchConditionsJson: async () => {
        if (failing) throw new Error("conditions feed responded 503");
        return closureFeed();
      },
    });

    await handles.runTrafficLiveNow();
    expect(writeLive.mock.calls[0]?.[0].overrides?.size).toBe(1);

    // Second cycle fails while the last good set is still inside the window.
    failing = true;
    vi.advanceTimersByTime(staleMs - 1);
    await handles.runTrafficLiveNow();
    expect(writeLive.mock.calls[1]?.[0].overrides?.get("0:1:2")).toMatchObject({ closed: true });
    expect(handles.getTrafficConditionsApplied().observationIds).toEqual(["a:1"]);

    // Past the window the closures are dropped rather than held open forever.
    vi.advanceTimersByTime(2);
    await handles.runTrafficLiveNow();
    expect(writeLive.mock.calls[2]?.[0].overrides?.size).toBe(0);
    const applied = handles.getTrafficConditionsApplied();
    expect(applied.observationIds).toEqual([]);
    expect(applied.resolverVersion).toBeNull();

    handles.stop();
  });

  it("triggers a ways-to-edges refresh at most once per hour when bound ways are missing from the map", async () => {
    const refreshWaysToEdges = vi.fn(async () => ({ wayCount: 0, edgeCount: 0 }));
    const handles = setupCronWithSeams({
      loadWaysToEdges: async () => new Map<number, WayEdge[]>(),
      getCoveredWayIds: async () => new Set<number>([10]),
      refreshWaysToEdges,
    });

    await handles.runTrafficLiveNow();
    await flush();
    await handles.runTrafficLiveNow();
    await flush();

    expect(refreshWaysToEdges).toHaveBeenCalledTimes(1);
    expect(refreshWaysToEdges).toHaveBeenCalledWith(new Set([10]), expect.anything());

    handles.stop();
  });

  it("does not schedule a refresh when every bound way is in the map", async () => {
    const refreshWaysToEdges = vi.fn(async () => ({ wayCount: 1, edgeCount: 1 }));
    const handles = setupCronWithSeams({
      getCoveredWayIds: async () => new Set<number>([10]),
      refreshWaysToEdges,
    });

    await handles.runTrafficLiveNow();
    await flush();

    expect(refreshWaysToEdges).not.toHaveBeenCalled();

    handles.stop();
  });

  it("writes live speeds without overrides when the conditions feed has never succeeded", async () => {
    const errorLog = vi.fn();
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      writeLiveTraffic: writeLive,
      fetchConditionsJson: async () => "{not json",
      logger: { info: () => {}, warn: () => {}, error: errorLog },
    });

    await handles.runTrafficLiveNow();

    expect(writeLive).toHaveBeenCalledTimes(1);
    expect(writeLive.mock.calls[0]?.[0].overrides?.size).toBe(0);
    // A bad conditions body is not a failed cycle: the live speeds still land.
    expect(errorLog).not.toHaveBeenCalled();
    expect(handles.getTrafficConditionsApplied().observationIds).toEqual([]);

    handles.stop();
  });

  it("traces spans through Valhalla and passes the edge subset to the writer", async () => {
    const infoLog = vi.fn();
    const trace = vi.fn(async () => [{ forward: true, level: 0, tile: 1, index: 7 }]);
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => closureFeedWithGeometry(),
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      writeLiveTraffic: writeLive,
      traceSpanEdges: trace,
      logger: { info: infoLog, warn: () => {}, error: () => {} },
    });

    await handles.runTrafficLiveNow();

    expect(trace).toHaveBeenCalledTimes(1);
    expect([...(writeLive.mock.calls[0]?.[0].overrides?.keys() ?? [])]).toEqual(["0:1:7"]);
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: conditions applied",
      expect.objectContaining({ edgeExactSpans: 1, wholeWaySpans: 0 }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: span tracing",
      expect.objectContaining({
        traced: 1,
        unanswered: 0,
        negative: 0,
        skippedBudget: 0,
        cacheHits: 0,
      }),
    );

    handles.stop();
  });

  it("falls back to whole-way when the trace seam returns null", async () => {
    const infoLog = vi.fn();
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => closureFeedWithGeometry(),
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      writeLiveTraffic: writeLive,
      traceSpanEdges: async () => null,
      logger: { info: infoLog, warn: () => {}, error: () => {} },
    });

    await handles.runTrafficLiveNow();

    expect([...(writeLive.mock.calls[0]?.[0].overrides?.keys() ?? [])].sort()).toEqual([
      "0:1:5",
      "0:1:7",
    ]);
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: conditions applied",
      expect.objectContaining({ edgeExactSpans: 0, wholeWaySpans: 1 }),
    );

    handles.stop();
  });

  it("still closes whole-way when the trace seam throws on every span", async () => {
    const infoLog = vi.fn();
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => closureFeedWithGeometry(),
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      writeLiveTraffic: writeLive,
      traceSpanEdges: (async () => {
        throw new Error("valhalla refused the connection");
      }) as unknown as CronSetupOptions["traceSpanEdges"],
      logger: { info: infoLog, warn: () => {}, error: () => {} },
    });

    await handles.runTrafficLiveNow();

    const overrides = writeLive.mock.calls[0]?.[0].overrides;
    expect([...(overrides?.keys() ?? [])].sort()).toEqual(["0:1:5", "0:1:7"]);
    expect(overrides?.get("0:1:5")).toMatchObject({ closed: true, observationId: "a:1" });
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: conditions applied",
      expect.objectContaining({ edgeExactSpans: 0, wholeWaySpans: 1 }),
    );
    // Unanswered rather than negative, so the next cycle traces the span again.
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: span tracing",
      expect.objectContaining({ unanswered: 1, negative: 0 }),
    );
    expect(handles.getTrafficConditionsApplied().observationIds).toEqual(["a:1"]);

    handles.stop();
  });

  it("writes live speeds with no overrides when classification throws", async () => {
    // The only cheap injection point: classification reads the way→edge map,
    // which is a seam, so a map that throws on lookup stands in for any
    // unexpected failure inside `conditionsToEdges`.
    class ThrowingWayMap extends Map<number, WayEdge[]> {
      override get(): WayEdge[] | undefined {
        throw new Error("way to edge lookup exploded");
      }
    }
    const warnLog = vi.fn();
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const handles = setupCronWithSeams({
      writeLiveTraffic: writeLive,
      loadWaysToEdges: async () => new ThrowingWayMap([[10, []]]),
      // Keeps the real tracer, which also reads the map, out of the picture so
      // the throw lands in classification.
      traceSpanEdges: async () => null,
      logger: { info: () => {}, warn: warnLog, error: () => {} },
    });

    await handles.runTrafficLiveNow();

    expect(writeLive).toHaveBeenCalledTimes(1);
    expect(writeLive.mock.calls[0]?.[0].overrides?.size).toBe(0);
    expect(warnLog).toHaveBeenCalledWith(
      "traffic-live: conditions classification failed, writing no overrides",
      expect.objectContaining({ err: "way to edge lookup exploded" }),
    );
    expect(handles.getTrafficConditionsApplied().observationIds).toEqual([]);

    handles.stop();
  });

  it("persists the span cache and reloads it across setupCron instances", async () => {
    const spanEdgeCachePath = await tempCachePath();
    const first = setupCronWithSeams({
      fetchConditionsJson: async () => closureFeedWithGeometry(),
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      traceSpanEdges: async () => [{ forward: true, level: 0, tile: 1, index: 7 }],
      spanEdgeCachePath,
    });
    await first.runTrafficLiveNow();
    first.stop();

    const infoLog = vi.fn();
    const trace = vi.fn(async () => {
      throw new Error("the second cycle must not trace");
    });
    const writeLive = vi.fn<(deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>>(
      async (deps) => writeResult(deps),
    );
    const second = setupCronWithSeams({
      fetchConditionsJson: async () => closureFeedWithGeometry(),
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      writeLiveTraffic: writeLive,
      traceSpanEdges: trace as unknown as CronSetupOptions["traceSpanEdges"],
      spanEdgeCachePath,
      logger: { info: infoLog, warn: () => {}, error: () => {} },
    });

    await second.runTrafficLiveNow();

    expect(trace).not.toHaveBeenCalled();
    expect([...(writeLive.mock.calls[0]?.[0].overrides?.keys() ?? [])]).toEqual(["0:1:7"]);
    expect(infoLog).toHaveBeenCalledWith(
      "traffic-live: span tracing",
      expect.objectContaining({ traced: 0, cacheHits: 1, edgeExactSpans: 1, wholeWaySpans: 0 }),
    );

    second.stop();
  });

  it("keeps the span cache through a conditions-feed outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
    let failing = false;
    const trace = vi.fn(async () => [{ forward: true, level: 0, tile: 1, index: 7 }]);
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => {
        if (failing) throw new Error("conditions feed responded 503");
        return closureFeedWithGeometry();
      },
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      traceSpanEdges: trace,
      trafficConditionsStaleMs: 1_000,
    });

    await handles.runTrafficLiveNow();
    expect(trace).toHaveBeenCalledTimes(1);

    // Past the stale window, so the outage cycle runs with no conditions at all.
    failing = true;
    vi.advanceTimersByTime(2_000);
    await handles.runTrafficLiveNow();

    // Back up: the trace from before the outage is still cached.
    failing = false;
    await handles.runTrafficLiveNow();
    expect(trace).toHaveBeenCalledTimes(1);

    handles.stop();
  });

  it("drops cached traces once the condition stops being reported", async () => {
    let feed = closureFeedWithGeometry();
    const trace = vi.fn(async () => [{ forward: true, level: 0, tile: 1, index: 7 }]);
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => feed,
      loadWaysToEdges: async () => waysToEdgesWithTwoForwardEdges(),
      traceSpanEdges: trace,
    });

    await handles.runTrafficLiveNow();
    expect(trace).toHaveBeenCalledTimes(1);

    // The closure is lifted: its span leaves both the file and this process.
    feed = JSON.stringify({ resolver_version: "r1", conditions: [] });
    await handles.runTrafficLiveNow();

    // Re-reported later, it is traced again rather than served from a cache
    // entry that was never pruned.
    feed = closureFeedWithGeometry();
    await handles.runTrafficLiveNow();
    expect(trace).toHaveBeenCalledTimes(2);

    handles.stop();
  });

  it("omits an observation the writer could not resolve onto any edge", async () => {
    const handles = setupCronWithSeams({
      fetchConditionsJson: async () => twoClosureFeed(),
      loadWaysToEdges: async () =>
        new Map<number, WayEdge[]>([
          [10, [{ forward: true, level: 0, tile: 1, index: 2 }]],
          [20, [{ forward: true, level: 0, tile: 9999, index: 0 }]],
        ]),
      // Way 20's tile is absent from this tar, so `a:2` was requested but
      // never written — the applied set must not claim it.
      writeLiveTraffic: async () => ({
        written: 1,
        matched: 0,
        total: 0,
        outOfBounds: 0,
        closedEdges: 1,
        cappedEdges: 0,
        overridesUnresolved: 1,
        appliedObservationIds: ["a:1"],
      }),
    });

    await handles.runTrafficLiveNow();

    expect(handles.getTrafficConditionsApplied().observationIds).toEqual(["a:1"]);

    handles.stop();
  });
});
