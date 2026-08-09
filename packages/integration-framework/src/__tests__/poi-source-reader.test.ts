import type { BBox, PoiLiveState } from "@openmapx/poi-source-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CacheClient,
  DatabaseClient,
  IntegrationContext,
  LiveStoreClient,
  Logger,
} from "../context";
import {
  __resetReaderState,
  createStaticPoiReader,
  createTwoTierPoiReader,
  isInColdStart,
  isLiveTooStale,
} from "../poi-source-reader.js";

interface Entity {
  id: string;
  name: string;
  free?: number | null;
}

// `DatabaseClient.execute` has a generic `<T>` signature that vi.fn() cannot
// satisfy directly. This wraps a plain mock into the right shape while still
// returning the underlying Mock for assertions.
function mockExecute<R>(impl: (query: string, params?: unknown[]) => Promise<R>): {
  fn: ReturnType<typeof vi.fn>;
  execute: DatabaseClient["execute"];
} {
  const fn = vi.fn(impl);
  const execute: DatabaseClient["execute"] = ((q: string, p?: unknown[]) =>
    fn(q, p)) as DatabaseClient["execute"];
  return { fn, execute };
}

function makeLogger(): Logger & { _calls: { warn: unknown[][]; info: unknown[][] } } {
  const warn = vi.fn();
  const info = vi.fn();
  return {
    info: info as Logger["info"],
    warn: warn as Logger["warn"],
    error: vi.fn() as Logger["error"],
    debug: vi.fn() as Logger["debug"],
    _calls: { warn: warn.mock.calls, info: info.mock.calls },
  };
}

function makeCache(): CacheClient {
  const withCache: CacheClient["withCache"] = async <T>(
    _k: string,
    _t: number,
    fn: () => Promise<T>,
  ) => fn();
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    withCache,
  };
}

function makeLiveStore(hmgetImpl?: LiveStoreClient["hmget"]): LiveStoreClient {
  const defaultHmget: LiveStoreClient["hmget"] = async <T>(_k: string, fields: readonly string[]) =>
    fields.map(() => null as T | null);
  return { hmget: hmgetImpl ?? defaultHmget };
}

interface CtxOverrides {
  db?: DatabaseClient | undefined;
  cache?: CacheClient;
  liveStore?: LiveStoreClient;
  log?: Logger;
}

function makeCtx(overrides: CtxOverrides = {}): IntegrationContext {
  const noop = () => undefined;
  const ctx = {
    id: "test",
    manifest: {} as IntegrationContext["manifest"],
    config: {},
    http: { get: vi.fn(), post: vi.fn() } as unknown as IntegrationContext["http"],
    cache: overrides.cache ?? makeCache(),
    liveStore: overrides.liveStore ?? makeLiveStore(),
    db: overrides.db,
    log: overrides.log ?? makeLogger(),
    secrets: { get: vi.fn(async () => null) },
    registerTransitProvider: noop,
    registerRealtimeProvider: noop,
    registerMobilityDataSource: noop,
    registerWeatherProvider: noop,
    registerGeocodingProvider: noop,
    registerRoutingProvider: noop,
    registerRideProvider: noop,
    registerPhotoProvider: noop,
    registerReviewProvider: noop,
    registerPoiSearchProvider: noop,
    registerKnowledgeProvider: noop,
    registerGtfsCatalogProvider: noop,
    registerRoute: noop,
    registerHealthCheck: noop,
    emit: noop,
    on: () => () => undefined,
    onShutdown: noop,
    getIntegrationsByDomain: () => [],
    getRequiredService: () => null,
  } satisfies Partial<IntegrationContext> as unknown as IntegrationContext;
  return ctx;
}

const mapStatic = (poiId: string, payload: unknown): Entity => {
  const p = (payload ?? {}) as { name?: string };
  return { id: poiId, name: p.name ?? "n/a" };
};

const mergeWithLive = (base: Entity, live: PoiLiveState | null): Entity => ({
  ...base,
  free: (live?.free as number | undefined) ?? null,
});

const BBOX_WORLD: BBox = [-180, -90, 180, 90];
const BBOX_DE: BBox = [5, 47, 15, 55];
const BBOX_US: BBox = [-125, 25, -65, 50];

beforeEach(() => {
  __resetReaderState();
});

describe("createStaticPoiReader", () => {
  it("happy path: maps rows in returned order", async () => {
    const rows = [
      { poi_id: "a", payload: { name: "A" } },
      { poi_id: "b", payload: { name: "B" } },
      { poi_id: "c", payload: { name: "C" } },
    ];
    const { fn, execute } = mockExecute(async () => rows);
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    const out = await reader.search(ctx, BBOX_WORLD);
    expect(out).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coverage short-circuit: returns [] without DB call when bbox is disjoint", async () => {
    const { fn, execute } = mockExecute(async () => []);
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({
      sourceId: "bnetza-ev",
      mapStatic,
      coverage: BBOX_DE,
    });
    const out = await reader.search(ctx, BBOX_US);
    expect(out).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("coverage: overlapping bbox still queries DB", async () => {
    const { fn, execute } = mockExecute(async () => []);
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({
      sourceId: "bnetza-ev",
      mapStatic,
      coverage: BBOX_DE,
    });
    await reader.search(ctx, [0, 40, 10, 50]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("table-missing: warns once across multiple calls and returns []", async () => {
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { execute } = mockExecute(async () => {
      throw err;
    });
    const log = makeLogger();
    const ctx = makeCtx({ db: { execute }, log });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });

    expect(await reader.search(ctx, BBOX_WORLD)).toEqual([]);
    expect(await reader.search(ctx, BBOX_WORLD)).toEqual([]);
    expect(await reader.fetchDetail(ctx, "x")).toBeNull();

    // Warn-once-per-source: only the first miss logs.
    expect((log.warn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("other DB errors propagate", async () => {
    const err = Object.assign(new Error("function does not exist"), { code: "42883" });
    const { execute } = mockExecute(async () => {
      throw err;
    });
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    await expect(reader.search(ctx, BBOX_WORLD)).rejects.toThrow("function does not exist");
  });

  it("db absent: search returns [], fetchDetail returns null", async () => {
    const ctx = makeCtx({ db: undefined });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    expect(await reader.search(ctx, BBOX_WORLD)).toEqual([]);
    expect(await reader.fetchDetail(ctx, "x")).toBeNull();
  });

  it("fetchDetail miss: returns null", async () => {
    const { execute } = mockExecute(async () => []);
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    expect(await reader.fetchDetail(ctx, "missing")).toBeNull();
  });

  it("fetchDetail hit: returns mapped entity", async () => {
    const { execute } = mockExecute(async () => [{ poi_id: "x", payload: { name: "X" } }]);
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    expect(await reader.fetchDetail(ctx, "x")).toEqual({ id: "x", name: "X" });
  });

  it("invalid sourceId throws at factory time", () => {
    expect(() => createStaticPoiReader<Entity>({ sourceId: "BAD ID", mapStatic })).toThrow();
    expect(() => createStaticPoiReader<Entity>({ sourceId: "-bad", mapStatic })).toThrow();
    expect(() =>
      createStaticPoiReader<Entity>({ sourceId: "bad_underscore", mapStatic }),
    ).toThrow();
  });
});

describe("createTwoTierPoiReader", () => {
  it("merges live data with static base entities", async () => {
    const rows = [
      { poi_id: "a", payload: { name: "A" } },
      { poi_id: "b", payload: { name: "B" } },
      { poi_id: "c", payload: { name: "C" } },
    ];
    const { execute } = mockExecute(async () => rows);
    const hmget = vi.fn(async (_k: string, fields: readonly string[]) =>
      fields.map((f) =>
        f === "a"
          ? { asOf: "2026-01-01T00:00:00Z", free: 5 }
          : f === "c"
            ? { asOf: "2026-01-01T00:00:00Z", free: 0 }
            : null,
      ),
    );
    const ctx = makeCtx({
      db: { execute },
      liveStore: makeLiveStore(hmget as LiveStoreClient["hmget"]),
    });
    const reader = createTwoTierPoiReader<Entity>({
      sourceId: "parking-x",
      mapStatic,
      mergeWithLive,
    });
    const out = await reader.search(ctx, BBOX_WORLD);
    expect(out).toEqual([
      { id: "a", name: "A", free: 5 },
      { id: "b", name: "B", free: null },
      { id: "c", name: "C", free: 0 },
    ]);
    expect(hmget).toHaveBeenCalledWith("poi:live:parking-x", ["a", "b", "c"]);
  });

  it("hmget rejection: returns base entities with mergeWithLive(base, null)", async () => {
    const rows = [
      { poi_id: "a", payload: { name: "A" } },
      { poi_id: "b", payload: { name: "B" } },
    ];
    const { execute } = mockExecute(async () => rows);
    const hmget = vi.fn(async () => {
      throw new Error("cache down");
    });
    const ctx = makeCtx({
      db: { execute },
      liveStore: makeLiveStore(hmget as LiveStoreClient["hmget"]),
    });
    const reader = createTwoTierPoiReader<Entity>({
      sourceId: "parking-x",
      mapStatic,
      mergeWithLive,
    });
    const out = await reader.search(ctx, BBOX_WORLD);
    expect(out).toEqual([
      { id: "a", name: "A", free: null },
      { id: "b", name: "B", free: null },
    ]);
  });

  it("malformed JSON field: treated as null (graceful)", async () => {
    const rows = [
      { poi_id: "a", payload: { name: "A" } },
      { poi_id: "b", payload: { name: "B" } },
    ];
    const { execute } = mockExecute(async () => rows);
    // Simulate the host having stored an unparseable string or wrong shape — host
    // returns `null` for parse failures per the LiveStoreClient contract; we also
    // defensively coerce non-object values to null.
    const hmget = vi.fn(async () => [null, "not-an-object"]);
    const ctx = makeCtx({
      db: { execute },
      liveStore: makeLiveStore(hmget as unknown as LiveStoreClient["hmget"]),
    });
    const reader = createTwoTierPoiReader<Entity>({
      sourceId: "parking-x",
      mapStatic,
      mergeWithLive,
    });
    const out = await reader.search(ctx, BBOX_WORLD);
    expect(out).toEqual([
      { id: "a", name: "A", free: null },
      { id: "b", name: "B", free: null },
    ]);
  });

  it("fetchDetail merges live for a single id", async () => {
    const { execute } = mockExecute(async () => [{ poi_id: "a", payload: { name: "A" } }]);
    const hmget = vi.fn(async () => [{ asOf: "2026-01-01T00:00:00Z", free: 9 }]);
    const ctx = makeCtx({
      db: { execute },
      liveStore: makeLiveStore(hmget as LiveStoreClient["hmget"]),
    });
    const reader = createTwoTierPoiReader<Entity>({
      sourceId: "parking-x",
      mapStatic,
      mergeWithLive,
    });
    expect(await reader.fetchDetail(ctx, "a")).toEqual({ id: "a", name: "A", free: 9 });
  });

  it("two-tier coverage short-circuit also skips cache", async () => {
    const { fn, execute } = mockExecute(async () => []);
    const hmget = vi.fn();
    const ctx = makeCtx({
      db: { execute },
      liveStore: makeLiveStore(hmget as LiveStoreClient["hmget"]),
    });
    const reader = createTwoTierPoiReader<Entity>({
      sourceId: "parking-x",
      mapStatic,
      mergeWithLive,
      coverage: BBOX_DE,
    });
    expect(await reader.search(ctx, BBOX_US)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    expect(hmget).not.toHaveBeenCalled();
  });
});

describe("isInColdStart", () => {
  it("returns false until a 42P01 is observed for the source", async () => {
    expect(isInColdStart("bnetza-ev")).toBe(false);

    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { execute } = mockExecute(async () => {
      throw err;
    });
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    await reader.search(ctx, BBOX_WORLD);

    expect(isInColdStart("bnetza-ev")).toBe(true);
    // Distinct sources are tracked independently.
    expect(isInColdStart("other-source")).toBe(false);
  });

  it("__resetReaderState clears the cold-start tracker", async () => {
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { execute } = mockExecute(async () => {
      throw err;
    });
    const ctx = makeCtx({ db: { execute } });
    const reader = createStaticPoiReader<Entity>({ sourceId: "bnetza-ev", mapStatic });
    await reader.search(ctx, BBOX_WORLD);
    expect(isInColdStart("bnetza-ev")).toBe(true);

    __resetReaderState();
    expect(isInColdStart("bnetza-ev")).toBe(false);
  });
});

describe("isLiveTooStale", () => {
  const NOW = Date.parse("2026-05-23T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when live is null", () => {
    expect(isLiveTooStale(null, 30_000)).toBe(false);
  });

  it("returns false when asOf is fresh", () => {
    expect(isLiveTooStale({ asOf: new Date(NOW - 1_000).toISOString() }, 30_000)).toBe(false);
  });

  it("returns true when asOf is older than the threshold", () => {
    expect(isLiveTooStale({ asOf: new Date(NOW - 60_000).toISOString() }, 30_000)).toBe(true);
  });

  it("returns true when asOf is unparseable (defensive)", () => {
    expect(isLiveTooStale({ asOf: "not-a-date" }, 30_000)).toBe(true);
  });
});
