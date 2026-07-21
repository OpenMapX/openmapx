import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PoiIngestKind,
  PoiIngestResult,
  PoiIngestStageResult,
} from "../../src/jobs/poi-ingest/types.js";

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
  (opts: Record<string, unknown>): Record<string, unknown> => ({ ...opts, state: {} }),
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
const onStageCompleteStub = vi.fn((_r: PoiIngestStageResult): Promise<void> => Promise.resolve());
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

import { noopMetricsSink, type PoiIngestMetricsSink } from "../../src/jobs/poi-ingest/metrics.js";
import {
  type PoiSchedulerLogger,
  setupPoiIngestCron,
} from "../../src/jobs/poi-ingest/scheduler.js";
import { createPoiSingleFlight } from "../../src/jobs/poi-ingest/single-flight.js";

function makeLogger(): PoiSchedulerLogger & {
  calls: { level: "info" | "warn" | "error"; msg: string; extra?: Record<string, unknown> }[];
} {
  const calls: {
    level: "info" | "warn" | "error";
    msg: string;
    extra?: Record<string, unknown>;
  }[] = [];
  return {
    calls,
    info: (msg, extra) => calls.push({ level: "info", msg, extra }),
    warn: (msg, extra) => calls.push({ level: "warn", msg, extra }),
    error: (msg, extra) => calls.push({ level: "error", msg, extra }),
  };
}

function staticSource(id = "src-1", cron = "0 * * * *"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "ev-charging",
    name: id,
    static: {
      cron,
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: function* () {},
    },
  } as RegisteredPoiSource;
}

function staticLiveSource(id = "src-1"): RegisteredPoiSource {
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

describe("setupPoiIngestCron", () => {
  const originalEnv = { ...process.env };

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
  });

  afterEach(() => {
    // Restore env so disable-flag tests don't leak.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("POI_INGEST_CRON__")) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("boots with an empty registry", () => {
    const logger = makeLogger();
    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [],
      metricsSink: noopMetricsSink,
    });
    expect(handles.crons.size).toBe(0);
    expect(handles.disabled).toEqual([]);
    const summary = logger.calls.find((c) => c.msg.includes("sources registered"));
    expect(summary?.msg).toBe("poi-ingest-cron: 0 sources registered, 0 disabled");
    expect(() => handles.stop()).not.toThrow();
  });

  it("schedules one cron for a static-only source", () => {
    const logger = makeLogger();
    const source = staticSource("src-1", "0 * * * *");
    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
    });
    expect(handles.crons.size).toBe(1);
    const cron = handles.crons.get("src-1:static");
    expect(cron).toBeDefined();
    expect(cron?.name).toBe("poi-ingest:src-1:static");

    const scheduled = logger.calls.filter((c) => c.msg === "poi-ingest-cron: scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.extra).toMatchObject({
      sourceId: "src-1",
      kind: "static",
      expression: "0 * * * *",
    });
    const summary = logger.calls.find((c) => c.msg.includes("sources registered"));
    expect(summary?.msg).toBe("poi-ingest-cron: 1 sources registered, 0 disabled");

    handles.stop();
  });

  it("schedules two crons for a source with static+live", () => {
    const logger = makeLogger();
    const source = staticLiveSource("src-1");
    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
    });
    expect(handles.crons.size).toBe(2);
    expect(handles.crons.has("src-1:static")).toBe(true);
    expect(handles.crons.has("src-1:live")).toBe(true);
    handles.stop();
  });

  it("schedules a bundled source under kind=bundled", () => {
    const logger = makeLogger();
    const source = bundledSource("bundled-1");
    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
    });
    expect(handles.crons.size).toBe(1);
    expect(handles.crons.get("bundled-1:bundled")?.name).toBe("poi-ingest:bundled-1:bundled");
    handles.stop();
  });

  it("honors env-var disable sentinels per (source, kind)", () => {
    process.env.POI_INGEST_CRON__SRC_1__STATIC = "disabled";
    const logger = makeLogger();
    const source = staticLiveSource("src-1");
    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
    });
    expect(handles.disabled).toEqual(["src-1:static"]);
    expect(handles.crons.has("src-1:static")).toBe(false);
    expect(handles.crons.has("src-1:live")).toBe(true);
    const disabledLog = logger.calls.find((c) => c.msg === "poi-ingest-cron: disabled by env");
    expect(disabledLog?.extra).toMatchObject({
      sourceId: "src-1",
      kind: "static",
      envName: "POI_INGEST_CRON__SRC_1__STATIC",
    });
    handles.stop();
  });

  it("runNow happy path: invokes the right pipeline, persists, records metrics, releases lock", async () => {
    const result = makeResult("src-1", "static", { staticRowCount: 42, staticHash: "h-new" });
    runStaticIngestMock.mockResolvedValue(result);
    const source = staticSource("src-1");
    const logger = makeLogger();
    const sink: PoiIngestMetricsSink = {
      recordRun: vi.fn(),
      recordDuration: vi.fn(),
      recordRowCount: vi.fn(),
    };
    const singleFlight = createPoiSingleFlight();

    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: sink,
      singleFlight,
    });

    await handles.runNow("src-1", "static");

    expect(runStaticIngestMock).toHaveBeenCalledTimes(1);
    expect(runLiveIngestMock).not.toHaveBeenCalled();
    expect(runBundledIngestMock).not.toHaveBeenCalled();
    expect(createPoiJobRowMock).toHaveBeenCalledTimes(1);
    const createArg = createPoiJobRowMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(createArg).toMatchObject({
      sourceId: "src-1",
      kind: "static",
      triggeredBy: "cron",
      metadata: { schedule: "0 * * * *" },
    });
    expect(finalizePoiJobRowMock).toHaveBeenCalledWith("job-1", "ok");
    expect(upsertPoiFeedStateMock).toHaveBeenCalledTimes(1);
    const upsertArg = upsertPoiFeedStateMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(upsertArg).toMatchObject({
      sourceId: "src-1",
      domain: "ev-charging",
      result,
    });
    expect(sink.recordRun).toHaveBeenCalledWith({
      sourceId: "src-1",
      kind: "static",
      outcome: "ok",
    });
    // Lock released — a second acquire should succeed.
    const reacquire = singleFlight.tryAcquire("src-1", "static");
    expect(reacquire.ok).toBe(true);

    handles.stop();
  });

  it("runNow skips when single-flight reports in-flight", async () => {
    const source = staticSource("src-1");
    const logger = makeLogger();
    const singleFlight = createPoiSingleFlight();
    // Pre-occupy the slot.
    singleFlight.tryAcquire("src-1", "static");

    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
      singleFlight,
    });

    await handles.runNow("src-1", "static");

    expect(runStaticIngestMock).not.toHaveBeenCalled();
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
    expect(upsertPoiFeedStateMock).not.toHaveBeenCalled();
    const warn = logger.calls.find((c) => c.msg === "poi-ingest-cron: skipped scheduled run");
    expect(warn?.extra).toMatchObject({ sourceId: "src-1", kind: "static", reason: "in-flight" });

    handles.stop();
  });

  it("runNow synthesises an error result and still finalises + upserts when the pipeline throws", async () => {
    const boom = new Error("pipeline blew up");
    runStaticIngestMock.mockRejectedValue(boom);
    const source = staticSource("src-1");
    const logger = makeLogger();
    const sink: PoiIngestMetricsSink = {
      recordRun: vi.fn(),
      recordDuration: vi.fn(),
      recordRowCount: vi.fn(),
    };

    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: sink,
    });

    await handles.runNow("src-1", "static");

    expect(finalizePoiJobRowMock).toHaveBeenCalledWith("job-1", "error");
    expect(upsertPoiFeedStateMock).toHaveBeenCalledTimes(1);
    const upsertErrArg = upsertPoiFeedStateMock.mock.calls[0]?.[0] as unknown as {
      result: PoiIngestResult;
    };
    expect(upsertErrArg.result.status).toBe("error");
    expect(upsertErrArg.result.error?.message).toBe("pipeline blew up");
    expect(sink.recordRun).toHaveBeenCalledWith({
      sourceId: "src-1",
      kind: "static",
      outcome: "error",
    });
    const errLog = logger.calls.find((c) => c.msg === "poi-ingest-cron: run threw");
    expect(errLog?.extra).toMatchObject({
      sourceId: "src-1",
      kind: "static",
      err: "pipeline blew up",
    });

    handles.stop();
  });

  it("bundled run reads previous hash and propagates it into ctx + upsert", async () => {
    getLastPoiFeedStateMock.mockResolvedValue({
      lastStaticHash: "h1",
      lastStaticRowCount: 42,
      lastStaticIngestAt: new Date(),
      consecutiveFailures: 0,
      status: "active",
    });
    const result = makeResult("bundled-1", "bundled", {
      staticRowCount: 42,
      liveRowCount: 5,
      skippedStaticSwap: true,
    });
    runBundledIngestMock.mockResolvedValue(result);
    const source = bundledSource("bundled-1");
    const logger = makeLogger();

    const handles = setupPoiIngestCron({
      sql: fakeSql(),
      redis: fakeRedis(),
      logger,
      sources: [source],
      metricsSink: noopMetricsSink,
    });

    await handles.runNow("bundled-1", "bundled");

    expect(getLastPoiFeedStateMock).toHaveBeenCalledWith("bundled-1");
    const ctxArg = buildPoiJobContextMock.mock.calls[0]?.[0] as unknown as {
      lastStaticHash?: string;
    };
    expect(ctxArg.lastStaticHash).toBe("h1");

    const upsertBundledArg = upsertPoiFeedStateMock.mock.calls[0]?.[0] as unknown as {
      previousStaticHash?: string;
      previousStaticRowCount?: number;
    };
    expect(upsertBundledArg.previousStaticHash).toBe("h1");
    expect(upsertBundledArg.previousStaticRowCount).toBe(42);

    handles.stop();
  });

  it("rethrows on invalid registry at boot", () => {
    const logger = makeLogger();
    const bad = [
      // Invalid id (uppercase) — validator should reject.
      { ...staticSource("src-1"), id: "BadId" } as RegisteredPoiSource,
    ];
    expect(() =>
      setupPoiIngestCron({
        sql: fakeSql(),
        redis: fakeRedis(),
        logger,
        sources: bad,
        metricsSink: noopMetricsSink,
      }),
    ).toThrow(/validatePoiSourceRegistry/);
    const errLog = logger.calls.find((c) => c.level === "error");
    expect(errLog?.msg).toBe("poi-ingest-cron: registry validation failed");
  });
});
