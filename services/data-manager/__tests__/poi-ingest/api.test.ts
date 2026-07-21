import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoiIngestKind, PoiIngestResult } from "../../src/jobs/poi-ingest/types.js";

// --- mock the pipeline -----------------------------------------------------
const runStaticIngestMock = vi.fn(
  (_ctx: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
);
const runLiveIngestMock = vi.fn(
  (_ctx: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
);
const runBundledIngestMock = vi.fn(
  (_ctx: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
);
const buildPoiJobContextMock = vi.fn(
  (opts: Record<string, unknown>): Record<string, unknown> => ({
    ...opts,
    state: {},
  }),
);

vi.mock("../../src/jobs/poi-ingest/pipeline.js", () => ({
  runStaticIngest: (...args: unknown[]) => runStaticIngestMock(...(args as [unknown])),
  runLiveIngest: (...args: unknown[]) => runLiveIngestMock(...(args as [unknown])),
  runBundledIngest: (...args: unknown[]) => runBundledIngestMock(...(args as [unknown])),
  buildPoiJobContext: (opts: Record<string, unknown>) => buildPoiJobContextMock(opts),
}));

// --- mock persistence ------------------------------------------------------
const createPoiJobRowMock = vi.fn(
  (_opts: Record<string, unknown>): Promise<string> => Promise.resolve("job-1"),
);
const finalizePoiJobRowMock = vi.fn(
  (_jobId: string, _status: string): Promise<void> => Promise.resolve(),
);
const upsertPoiFeedStateMock = vi.fn(
  (_opts: Record<string, unknown>): Promise<void> => Promise.resolve(),
);
type LastFeedState =
  | {
      lastStaticHash: string | null;
      lastStaticRowCount: number | null;
      lastStaticIngestAt: Date | null;
      consecutiveFailures: number;
      status: string;
    }
  | undefined;
const getLastPoiFeedStateMock = vi.fn(
  (_sourceId: string): Promise<LastFeedState> => Promise.resolve(undefined),
);
const onStageCompleteStub = vi.fn();
const makePoiPersistingOnStageCompleteMock = vi.fn(
  (_jobId: string, _logger: unknown) => onStageCompleteStub,
);

vi.mock("../../src/jobs/poi-ingest/persistence.js", () => ({
  createPoiJobRow: (...args: unknown[]) =>
    createPoiJobRowMock(...(args as [Record<string, unknown>])),
  finalizePoiJobRow: (...args: unknown[]) => finalizePoiJobRowMock(...(args as [string, string])),
  upsertPoiFeedState: (...args: unknown[]) =>
    upsertPoiFeedStateMock(...(args as [Record<string, unknown>])),
  getLastPoiFeedState: (...args: unknown[]) => getLastPoiFeedStateMock(...(args as [string])),
  makePoiPersistingOnStageComplete: (...args: unknown[]) =>
    makePoiPersistingOnStageCompleteMock(...(args as [string, unknown])),
}));

// --- mock db ---------------------------------------------------------------
// The API issues three distinct shapes of read:
//   - select().from(poiFeedState)                              → all rows
//   - select().from(poiFeedState).where(eq).limit(1)           → single row
//   - select().from(jobs).where(drizzleSql).orderBy().limit()  → recent jobs
// We capture them as a sequence and let each test set the response queue.
const dbReadQueue: unknown[][] = [];

function shiftRead(): unknown[] {
  return dbReadQueue.shift() ?? [];
}

vi.mock("../../src/db/index.js", () => {
  return {
    db: {
      select(_fields?: unknown) {
        return {
          from(_table: unknown) {
            // No-arg .from() result is itself thenable so the API code can
            // `await db.select().from(table)` to get all rows.
            const allRowsBuilder = {
              where(_predicate: unknown) {
                return {
                  limit(_n: number) {
                    return Promise.resolve(shiftRead());
                  },
                  orderBy(_o: unknown) {
                    return {
                      limit(_n: number) {
                        return Promise.resolve(shiftRead());
                      },
                    };
                  },
                };
              },
              // biome-ignore lint/suspicious/noThenProperty: mocks Drizzle's thenable query builder
              then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                return Promise.resolve(shiftRead()).then(onFulfilled, onRejected);
              },
            };
            return allRowsBuilder;
          },
        };
      },
    },
    sql: {},
  };
});

import { registerPoiIngestApi } from "../../src/jobs/poi-ingest/api.js";
import { noopMetricsSink, type PoiIngestMetricsSink } from "../../src/jobs/poi-ingest/metrics.js";
import { createPoiSingleFlight } from "../../src/jobs/poi-ingest/single-flight.js";

function staticSource(id = "src-1"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "ev-charging",
    name: id,
    static: {
      cron: "0 * * * *",
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: function* () {},
    },
  } as RegisteredPoiSource;
}

function staticLiveSource(id = "src-live"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "ev-charging",
    name: id,
    static: {
      cron: "0 * * * *",
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: function* () {},
    },
    live: {
      cron: "*/5 * * * *",
      fetch: { type: "http", url: "https://example.com/live.json" },
      parse: () => new Map(),
    },
  } as RegisteredPoiSource;
}

function bundledSource(id = "bundled-1"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "parking",
    name: id,
    bundled: {
      cron: "*/10 * * * *",
      fetch: { type: "http", url: "https://example.com/feed.json" },
      parse: () => ({ static: [], live: new Map() }),
    },
  } as RegisteredPoiSource;
}

function fakeSql(): import("postgres").Sql {
  return {} as unknown as import("postgres").Sql;
}
function fakeRedis(): import("ioredis").Redis {
  return {} as unknown as import("ioredis").Redis;
}

function makeResult(
  sourceId: string,
  kind: PoiIngestKind,
  overrides: Partial<PoiIngestResult> = {},
): PoiIngestResult {
  return {
    sourceId,
    kind,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: "ok",
    stages: [],
    ...overrides,
  };
}

interface BuildAppOpts {
  sources?: readonly RegisteredPoiSource[];
  singleFlight?: ReturnType<typeof createPoiSingleFlight>;
  metricsSink?: PoiIngestMetricsSink;
}

async function buildApp(opts: BuildAppOpts = {}) {
  const app = Fastify();
  const singleFlight = opts.singleFlight ?? createPoiSingleFlight();
  const metricsSink = opts.metricsSink ?? noopMetricsSink;
  registerPoiIngestApi(app, {
    sql: fakeSql(),
    redis: fakeRedis(),
    singleFlight,
    metricsSink,
    sources: opts.sources,
  });
  return { app, singleFlight, metricsSink };
}

beforeEach(() => {
  runStaticIngestMock.mockReset();
  runLiveIngestMock.mockReset();
  runBundledIngestMock.mockReset();
  buildPoiJobContextMock.mockClear();
  createPoiJobRowMock.mockReset();
  finalizePoiJobRowMock.mockReset();
  upsertPoiFeedStateMock.mockReset();
  getLastPoiFeedStateMock.mockReset();
  onStageCompleteStub.mockReset();
  makePoiPersistingOnStageCompleteMock.mockClear();

  createPoiJobRowMock.mockResolvedValue("job-1");
  finalizePoiJobRowMock.mockResolvedValue(undefined);
  upsertPoiFeedStateMock.mockResolvedValue(undefined);
  getLastPoiFeedStateMock.mockResolvedValue(undefined);

  dbReadQueue.length = 0;
});

afterEach(() => {
  dbReadQueue.length = 0;
});

describe("GET /poi-ingest/state", () => {
  it("returns zeros for an empty registry", async () => {
    const { app } = await buildApp({ sources: [] });
    dbReadQueue.push([]); // loadAllFeedStateRows -> no rows
    const res = await app.inject({ method: "GET", url: "/poi-ingest/state" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      sourcesCount: 0,
      byDomain: {},
      byStatus: { active: 0, stale: 0, failed: 0, unknown: 0 },
      recentFailures: [],
      inflight: [],
      registryCountMatchesUpstream: "unknown",
    });
    await app.close();
  });

  it("aggregates byStatus + surfaces recentFailures", async () => {
    const sources = [staticSource("src-1"), bundledSource("bundled-1")];
    const { app } = await buildApp({ sources });
    dbReadQueue.push([
      {
        sourceId: "src-1",
        domain: "ev-charging",
        status: "failed",
        consecutiveFailures: 3,
        lastError: { message: "boom" },
        lastStaticIngestAt: new Date("2025-01-01T10:00:00.000Z"),
        lastStaticRowCount: 10,
        lastLiveIngestAt: null,
        lastLiveRowCount: null,
        lastStaticHash: "h1",
      },
      // bundled-1 has no row → counts as "unknown"
    ]);

    const res = await app.inject({ method: "GET", url: "/poi-ingest/state" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sourcesCount).toBe(2);
    expect(body.byDomain).toEqual({ "ev-charging": 1, parking: 1 });
    expect(body.byStatus).toEqual({
      active: 0,
      stale: 0,
      failed: 1,
      unknown: 1,
    });
    expect(body.recentFailures).toEqual([
      {
        sourceId: "src-1",
        domain: "ev-charging",
        consecutiveFailures: 3,
        lastError: { message: "boom" },
        lastStaticIngestAt: "2025-01-01T10:00:00.000Z",
        lastLiveIngestAt: null,
      },
    ]);
    await app.close();
  });

  it("includes inflight entries from the single-flight registry", async () => {
    const singleFlight = createPoiSingleFlight();
    singleFlight.tryAcquire("src-1", "static");
    const { app } = await buildApp({
      sources: [staticSource("src-1")],
      singleFlight,
    });
    dbReadQueue.push([]);
    const res = await app.inject({ method: "GET", url: "/poi-ingest/state" });
    const body = JSON.parse(res.body);
    expect(body.inflight).toHaveLength(1);
    expect(body.inflight[0]).toMatchObject({ sourceId: "src-1", kind: "static" });
    expect(typeof body.inflight[0].startedAt).toBe("string");
    await app.close();
  });
});

describe("GET /poi-ingest/sources", () => {
  it("returns null timestamps + status=unknown for never-ingested sources", async () => {
    const { app } = await buildApp({
      sources: [staticLiveSource("src-1")],
    });
    dbReadQueue.push([]);
    const res = await app.inject({ method: "GET", url: "/poi-ingest/sources" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toEqual([
      {
        sourceId: "src-1",
        domain: "ev-charging",
        name: "src-1",
        kinds: ["static", "live"],
        status: "unknown",
        consecutiveFailures: 0,
        lastStaticIngestAt: null,
        lastLiveIngestAt: null,
        lastStaticRowCount: null,
        lastLiveRowCount: null,
      },
    ]);
    await app.close();
  });

  it("filters by domain", async () => {
    const sources = [staticSource("src-1"), bundledSource("bundled-1")];
    const { app } = await buildApp({ sources });
    dbReadQueue.push([]);
    const res = await app.inject({
      method: "GET",
      url: "/poi-ingest/sources?domain=parking",
    });
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].sourceId).toBe("bundled-1");
    await app.close();
  });

  it("filters by status", async () => {
    const sources = [staticSource("src-1"), staticSource("src-2")];
    const { app } = await buildApp({ sources });
    dbReadQueue.push([
      {
        sourceId: "src-1",
        domain: "ev-charging",
        status: "failed",
        consecutiveFailures: 1,
        lastError: { message: "x" },
        lastStaticIngestAt: null,
        lastStaticRowCount: null,
        lastLiveIngestAt: null,
        lastLiveRowCount: null,
        lastStaticHash: null,
      },
      {
        sourceId: "src-2",
        domain: "ev-charging",
        status: "active",
        consecutiveFailures: 0,
        lastError: null,
        lastStaticIngestAt: new Date("2025-01-02T00:00:00.000Z"),
        lastStaticRowCount: 99,
        lastLiveIngestAt: null,
        lastLiveRowCount: null,
        lastStaticHash: "h",
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/poi-ingest/sources?status=failed",
    });
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].sourceId).toBe("src-1");
    await app.close();
  });
});

describe("GET /poi-ingest/sources/:id", () => {
  it("returns 404 for unknown source id", async () => {
    const { app } = await buildApp({ sources: [staticSource("src-1")] });
    const res = await app.inject({
      method: "GET",
      url: "/poi-ingest/sources/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns full source detail with recentJobs", async () => {
    const { app } = await buildApp({ sources: [staticLiveSource("src-1")] });
    const started = new Date("2025-01-01T00:00:00.000Z");
    const finished = new Date("2025-01-01T00:00:05.000Z");
    dbReadQueue.push([
      {
        sourceId: "src-1",
        domain: "ev-charging",
        status: "active",
        consecutiveFailures: 0,
        lastError: null,
        lastStaticIngestAt: new Date("2025-01-01T00:00:00.000Z"),
        lastStaticRowCount: 42,
        lastStaticHash: "h",
        lastLiveIngestAt: new Date("2025-01-01T00:01:00.000Z"),
        lastLiveRowCount: 10,
      },
    ]); // poiFeedState single-row
    dbReadQueue.push([
      {
        id: "job-1",
        kind: "poi-ingest:static",
        status: "ok",
        startedAt: started,
        finishedAt: finished,
        triggeredBy: "cron",
        metadata: { sourceId: "src-1" },
        idempotencyKey: null,
      },
    ]); // recent jobs
    const res = await app.inject({
      method: "GET",
      url: "/poi-ingest/sources/src-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toMatchObject({
      id: "src-1",
      domain: "ev-charging",
      name: "src-1",
      stationIdPrefix: "src-1:",
      coverage: null,
      kinds: {
        static: { cron: "0 * * * *" },
        live: { cron: "*/5 * * * *" },
      },
    });
    expect(body.feedState).toMatchObject({
      sourceId: "src-1",
      status: "active",
      consecutiveFailures: 0,
      lastStaticRowCount: 42,
    });
    expect(body.recentJobs).toEqual([
      {
        jobId: "job-1",
        kind: "poi-ingest:static",
        status: "ok",
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: 5000,
      },
    ]);
    await app.close();
  });
});

describe("POST /poi-ingest/sources/:id/sync", () => {
  it("404 on unknown source id", async () => {
    const { app } = await buildApp({ sources: [staticSource("src-1")] });
    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/nope/sync",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("409 when single-flight is busy", async () => {
    const singleFlight = createPoiSingleFlight();
    singleFlight.tryAcquire("src-1", "static");
    const { app } = await buildApp({
      sources: [staticSource("src-1")],
      singleFlight,
    });
    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/src-1/sync",
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: false, reason: "in-flight" });
    expect(typeof body.existingStartedAt).toBe("string");
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("202 + fires pipeline async; finalize+upsert+metrics+release run", async () => {
    let resolvePipeline: () => void = () => {};
    const pipelinePromise = new Promise<void>((r) => {
      resolvePipeline = r;
    });
    const result = makeResult("src-1", "static", { staticRowCount: 7 });
    runStaticIngestMock.mockImplementation(async () => {
      await pipelinePromise;
      return result;
    });

    const sink: PoiIngestMetricsSink = {
      recordRun: vi.fn(),
      recordDuration: vi.fn(),
      recordRowCount: vi.fn(),
    };
    const singleFlight = createPoiSingleFlight();
    const { app } = await buildApp({
      sources: [staticSource("src-1")],
      singleFlight,
      metricsSink: sink,
    });

    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/src-1/sync",
      payload: { idempotencyKey: "abc", triggeredBy: "florian" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      ok: true,
      jobId: "job-1",
      kind: "static",
      status: "started",
    });

    // The lock is held until the pipeline resolves.
    expect(singleFlight.getInflight("src-1", "static")).not.toBeNull();

    // Audit row was created with the right metadata immediately.
    expect(createPoiJobRowMock).toHaveBeenCalledTimes(1);
    const arg = createPoiJobRowMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.triggeredBy).toBe("manual:florian");
    expect(arg.kind).toBe("static");
    expect((arg.metadata as { idempotencyKey?: string }).idempotencyKey).toBe("abc");

    resolvePipeline();
    await vi.waitFor(() => {
      expect(finalizePoiJobRowMock).toHaveBeenCalledWith("job-1", "ok");
    });
    await vi.waitFor(() => {
      expect(upsertPoiFeedStateMock).toHaveBeenCalledTimes(1);
    });
    expect(sink.recordRun).toHaveBeenCalledWith({
      sourceId: "src-1",
      kind: "static",
      outcome: "ok",
    });
    // Lock was released after the pipeline finished.
    await vi.waitFor(() => {
      expect(singleFlight.getInflight("src-1", "static")).toBeNull();
    });

    await app.close();
  });

  it("bundled source: uses kind=bundled and reads previous hash", async () => {
    runBundledIngestMock.mockResolvedValue(
      makeResult("bundled-1", "bundled", {
        staticRowCount: 42,
        liveRowCount: 5,
      }),
    );
    getLastPoiFeedStateMock.mockResolvedValue({
      lastStaticHash: "prev-hash",
      lastStaticRowCount: 99,
      lastStaticIngestAt: new Date(),
      consecutiveFailures: 0,
      status: "active",
    });
    const { app } = await buildApp({ sources: [bundledSource("bundled-1")] });

    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/bundled-1/sync",
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).kind).toBe("bundled");

    expect(getLastPoiFeedStateMock).toHaveBeenCalledWith("bundled-1");
    await vi.waitFor(() => {
      expect(upsertPoiFeedStateMock).toHaveBeenCalled();
    });
    const upsertArg = upsertPoiFeedStateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertArg.previousStaticHash).toBe("prev-hash");
    expect(upsertArg.previousStaticRowCount).toBe(99);

    await app.close();
  });
});

describe("POST /poi-ingest/sources/:id/sync-live", () => {
  it("400 when the source has no live spec", async () => {
    const { app } = await buildApp({ sources: [staticSource("src-1")] });
    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/src-1/sync-live",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: false, error: "no-live-spec" });
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 on a bundled source (callers must use /sync)", async () => {
    const { app } = await buildApp({ sources: [bundledSource("bundled-1")] });
    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/bundled-1/sync-live",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      error: "bundled-source-use-sync-instead",
    });
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("202 + kind=live on a source with a live spec", async () => {
    runLiveIngestMock.mockResolvedValue(makeResult("src-live", "live", { liveRowCount: 11 }));
    const { app } = await buildApp({
      sources: [staticLiveSource("src-live")],
    });
    const res = await app.inject({
      method: "POST",
      url: "/poi-ingest/sources/src-live/sync-live",
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      jobId: "job-1",
      kind: "live",
      status: "started",
    });
    await vi.waitFor(() => {
      expect(runLiveIngestMock).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(finalizePoiJobRowMock).toHaveBeenCalledWith("job-1", "ok");
    });
    await app.close();
  });
});
