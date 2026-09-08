import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BoundCondition,
  type BoundSpan,
  spanKey,
} from "../jobs/traffic/conditions-to-edges.js";
import {
  loadSpanEdgeCache,
  resolveSpanEdges,
  type SpanEdgeCache,
  saveSpanEdgeCache,
  traceSpanEdges,
} from "../jobs/traffic/span-edges.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";

// GraphId value for {level 0, tile 1, index 7} = (7 << 25) | (1 << 3) | 0
const gid = (level: number, tile: number, index: number): number =>
  index * 2 ** 25 + tile * 8 + level;
const W2E = new Map<number, WayEdge[]>([
  [
    10,
    [
      { forward: true, level: 0, tile: 1, index: 5 },
      { forward: false, level: 0, tile: 1, index: 6 },
      { forward: true, level: 0, tile: 1, index: 7 },
    ],
  ],
]);
const span: BoundSpan = {
  wayId: 10,
  dir: "f",
  startFraction: 0.6,
  endFraction: 1,
  geometry: [
    [6.81, 51.2],
    [6.82, 51.2],
  ],
};

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe("traceSpanEdges", () => {
  it("returns only edges Valhalla matched that the way→edge map lists for this way and direction", async () => {
    const f = fetchReturning({
      edges: [
        { id: gid(0, 1, 7), way_id: 10 },
        { id: gid(0, 1, 6), way_id: 10 },
        { id: gid(0, 1, 9), way_id: 99 },
      ],
      matched_points: [
        { type: "matched", edge_index: 0 },
        { type: "matched", edge_index: 0 },
      ],
    });
    const edges = await traceSpanEdges(span, {
      valhallaUrl: "http://v:8002",
      waysToEdges: W2E,
      fetch: f,
    });
    expect(edges).toEqual([{ forward: true, level: 0, tile: 1, index: 7 }]);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(f).mock.calls[0] ?? [];
    expect(url).toBe("http://v:8002/trace_attributes");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.shape).toEqual([
      { lat: 51.2, lon: 6.81 },
      { lat: 51.2, lon: 6.82 },
    ]);
    expect(body.shape_match).toBe("map_snap");
    expect(body.filters.attributes).toContain("edge.id");
  });

  it("falls back (null) on no accepted edge, on mostly-unmatched points, and on missing geometry", async () => {
    const deps = { valhallaUrl: "http://v:8002", waysToEdges: W2E };
    expect(
      await traceSpanEdges(span, {
        ...deps,
        fetch: fetchReturning({
          edges: [{ id: gid(0, 1, 6), way_id: 10 }],
          matched_points: [{ type: "matched" }],
        }),
      }),
    ).toBeNull(); // wrong direction only
    expect(
      await traceSpanEdges(span, {
        ...deps,
        fetch: fetchReturning({
          edges: [{ id: gid(0, 1, 7), way_id: 10 }],
          matched_points: [{ type: "unmatched" }, { type: "unmatched" }, { type: "matched" }],
        }),
      }),
    ).toBeNull();
    expect(
      await traceSpanEdges({ ...span, geometry: null }, { ...deps, fetch: fetchReturning({}) }),
    ).toBeNull();
  });

  it("reports a transport failure (undefined) on HTTP error, on a throwing request, and on a non-JSON body", async () => {
    const deps = { valhallaUrl: "http://v:8002", waysToEdges: W2E };
    expect(
      await traceSpanEdges(span, { ...deps, fetch: fetchReturning({ error: "x" }, 400) }),
    ).toBeUndefined();
    expect(
      await traceSpanEdges(span, { ...deps, fetch: fetchReturning({ error: "x" }, 503) }),
    ).toBeUndefined();

    const rejecting = vi.fn().mockRejectedValue(new Error("timeout")) as unknown as typeof fetch;
    const warn = vi.fn();
    expect(
      await traceSpanEdges(span, { ...deps, fetch: rejecting, logger: { warn } }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    const badBody = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }) as unknown as typeof fetch;
    expect(await traceSpanEdges(span, { ...deps, fetch: badBody })).toBeUndefined();
  });

  it("falls back (null) when the way is unknown, without spending a request", async () => {
    const deps = { valhallaUrl: "http://v:8002", waysToEdges: W2E };
    const unknownWay = fetchReturning({
      edges: [{ id: gid(0, 1, 7), way_id: 42 }],
      matched_points: [{ type: "matched" }],
    });
    expect(await traceSpanEdges({ ...span, wayId: 42 }, { ...deps, fetch: unknownWay })).toBeNull();
    expect((unknownWay as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("de-duplicates repeated edge ids and accepts a backward span against backward edges", async () => {
    const f = fetchReturning({
      edges: [
        { id: gid(0, 1, 6), way_id: 10 },
        { id: gid(0, 1, 6), way_id: 10 },
        { id: gid(0, 1, 7), way_id: 10 },
      ],
      matched_points: [{ type: "matched" }, { type: "interpolated" }],
    });
    const edges = await traceSpanEdges(
      { ...span, dir: "b" },
      { valhallaUrl: "http://v:8002", waysToEdges: W2E, fetch: f },
    );
    expect(edges).toEqual([{ forward: false, level: 0, tile: 1, index: 6 }]);
  });
});

describe("resolveSpanEdges", () => {
  const cond: BoundCondition = {
    id: "a:1",
    type: "road_closure",
    roadState: "closed",
    speedLimitKph: null,
    vehiclesAffected: [],
    originKind: "feed",
    routingEligible: true,
    bindingStatus: "exact",
    segments: [span],
  };

  it("traces uncached spans once, then serves from cache (including negative results)", async () => {
    const f = fetchReturning({
      edges: [{ id: gid(0, 1, 7), way_id: 10 }],
      matched_points: [{ type: "matched" }],
    });
    const cache: SpanEdgeCache = new Map();
    const a = await resolveSpanEdges([cond], cache, {
      valhallaUrl: "http://v:8002",
      waysToEdges: W2E,
      fetch: f,
    });
    expect(a.traced).toBe(1);
    expect(a.resolved.get(spanKey("a:1", span))).toHaveLength(1);
    const b = await resolveSpanEdges([cond], cache, {
      valhallaUrl: "http://v:8002",
      waysToEdges: W2E,
      fetch: f,
    });
    expect(b.cacheHits).toBe(1);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("skips spans of non-routing-relevant or crowd-ineligible conditions", async () => {
    const f = fetchReturning({});
    const r = await resolveSpanEdges([{ ...cond, bindingStatus: "ambiguous" }], new Map(), {
      valhallaUrl: "http://v:8002",
      waysToEdges: W2E,
      fetch: f,
    });
    expect(r.traced).toBe(0);
    const crowd = await resolveSpanEdges(
      [{ ...cond, originKind: "crowd", routingEligible: false }],
      new Map(),
      { valhallaUrl: "http://v:8002", waysToEdges: W2E, fetch: f },
    );
    expect(crowd.traced).toBe(0);
  });

  it("caches a no-match trace so the next cycle does not re-trace it", async () => {
    const trace = vi.fn().mockResolvedValue(null);
    const cache: SpanEdgeCache = new Map();
    const deps = { valhallaUrl: "http://v:8002", waysToEdges: W2E };
    const a = await resolveSpanEdges([cond], cache, deps, trace);
    expect(a).toMatchObject({ traced: 1, negative: 1, unanswered: 0, cacheHits: 0 });
    expect(a.resolved.size).toBe(0);
    expect(cache.get(spanKey("a:1", span))).toBeNull();
    const b = await resolveSpanEdges([cond], cache, deps, trace);
    expect(b).toMatchObject({ traced: 0, negative: 0, unanswered: 0, cacheHits: 1 });
    expect(b.resolved.size).toBe(0);
    expect(trace).toHaveBeenCalledTimes(1);
  });

  it("does not cache a transport failure, so the span is retried next cycle", async () => {
    const f = fetchReturning({ error: "service unavailable" }, 503);
    const cache: SpanEdgeCache = new Map();
    const deps = { valhallaUrl: "http://v:8002", waysToEdges: W2E, fetch: f };

    const a = await resolveSpanEdges([cond], cache, deps);
    expect(a).toMatchObject({ traced: 1, unanswered: 1, negative: 0, cacheHits: 0 });
    expect(a.resolved.size).toBe(0);
    expect(cache.has(spanKey("a:1", span))).toBe(false);

    const b = await resolveSpanEdges([cond], cache, deps);
    expect(b).toMatchObject({ traced: 1, unanswered: 1, negative: 0, cacheHits: 0 });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("stops dispatching traces once the time budget is spent", async () => {
    const conditions: BoundCondition[] = Array.from({ length: 20 }, (_, i) => ({
      ...cond,
      id: `a:${i}`,
    }));
    const trace = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return null;
    });
    const cache: SpanEdgeCache = new Map();

    const startedAt = Date.now();
    const result = await resolveSpanEdges(
      conditions,
      cache,
      { valhallaUrl: "http://v:8002", waysToEdges: W2E, concurrency: 1, budgetMs: 60 },
      trace,
    );
    const elapsed = Date.now() - startedAt;

    // Unbudgeted this would take 20 × 50 ms; the pass returns after a couple of
    // traces and leaves the rest to the next cycle.
    expect(elapsed).toBeLessThan(500);
    expect(result.traced).toBeGreaterThan(0);
    expect(result.traced).toBeLessThan(20);
    expect(trace).toHaveBeenCalledTimes(result.traced);
    expect(result.skippedBudget).toBe(20 - result.traced);
    // Only the spans actually traced left a verdict behind.
    expect(cache.size).toBe(result.traced);
    expect(result.negative).toBe(result.traced);
  });

  it("traces each distinct span once and never runs more than `concurrency` traces at a time", async () => {
    const conditions: BoundCondition[] = Array.from({ length: 9 }, (_, i) => ({
      ...cond,
      id: `a:${i}`,
      segments: [{ ...span, wayId: 10 + (i % 3) }],
    }));
    // The same span twice within one cycle must produce a single trace call.
    conditions.push({ ...cond, id: "a:0", segments: [{ ...span, wayId: 10 }] });
    let inFlight = 0;
    let peak = 0;
    const trace = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return [{ forward: true, level: 0, tile: 1, index: 7 }] satisfies WayEdge[];
    });
    const result = await resolveSpanEdges(
      conditions,
      new Map(),
      { valhallaUrl: "http://v:8002", waysToEdges: W2E, concurrency: 3 },
      trace as unknown as typeof traceSpanEdges,
    );
    expect(result.traced).toBe(9);
    expect(trace).toHaveBeenCalledTimes(9);
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.resolved.size).toBe(9);
  });

  it("never throws when the trace seam rejects", async () => {
    const trace = vi.fn().mockRejectedValue(new Error("boom"));
    const warn = vi.fn();
    const cache: SpanEdgeCache = new Map();
    const result = await resolveSpanEdges(
      [cond],
      cache,
      { valhallaUrl: "http://v:8002", waysToEdges: W2E, logger: { warn } },
      trace,
    );
    expect(result).toMatchObject({ traced: 1, unanswered: 1, negative: 0 });
    expect(result.resolved.size).toBe(0);
    // A thrown trace is a transport failure, not a verdict about the span.
    expect(cache.has(spanKey("a:1", span))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("span edge cache persistence", () => {
  it("round-trips through the state file and keeps only the referenced keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "span-edges-"));
    const path = join(dir, "nested", "span_edges.json");
    const cache: SpanEdgeCache = new Map([
      ["keep", [{ forward: true, level: 0, tile: 1, index: 7 }]],
      ["keep-negative", null],
      ["drop", [{ forward: false, level: 0, tile: 1, index: 6 }]],
    ]);
    await saveSpanEdgeCache(path, cache, ["keep", "keep-negative", "absent"]);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(written).sort()).toEqual(["keep", "keep-negative"]);

    const loaded = await loadSpanEdgeCache(path);
    expect(loaded.get("keep")).toEqual([{ forward: true, level: 0, tile: 1, index: 7 }]);
    expect(loaded.has("keep-negative")).toBe(true);
    expect(loaded.get("keep-negative")).toBeNull();
    expect(loaded.has("drop")).toBe(false);
  });

  it("returns an empty cache for a missing or corrupt state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "span-edges-"));
    expect((await loadSpanEdgeCache(join(dir, "missing.json"))).size).toBe(0);
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json", "utf8");
    expect((await loadSpanEdgeCache(corrupt)).size).toBe(0);
    const wrongShape = join(dir, "array.json");
    await writeFile(wrongShape, '["nope"]', "utf8");
    expect((await loadSpanEdgeCache(wrongShape)).size).toBe(0);
  });
});
