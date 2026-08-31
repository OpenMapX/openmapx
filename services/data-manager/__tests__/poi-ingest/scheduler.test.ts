import "./support/poi-ingest-environment.js";

import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopMetricsSink, type PoiIngestMetricsSink } from "../../src/jobs/poi-ingest/metrics.js";
import {
  type PoiSchedulerLogger,
  setupPoiIngestCron,
} from "../../src/jobs/poi-ingest/scheduler.js";
import { createPoiSingleFlight } from "../../src/jobs/poi-ingest/single-flight.js";
import type { PoiIngestResult } from "../../src/jobs/poi-ingest/types.js";
import {
  bundledPoiSource as bundledSource,
  fakePoiRedis as fakeRedis,
  fakePoiSql as fakeSql,
  getPoiIngestTestMocks,
  makePoiIngestResult as makeResult,
  resetPoiIngestTestMocks,
  staticLivePoiSource as staticLiveSource,
  staticPoiSource as staticSource,
} from "./support/poi-ingest-environment.js";

const {
  buildPoiJobContextMock,
  createPoiJobRowMock,
  finalizePoiJobRowMock,
  getLastPoiFeedStateMock,
  runBundledIngestMock,
  runLiveIngestMock,
  runStaticIngestMock,
  upsertPoiFeedStateMock,
} = getPoiIngestTestMocks();

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

describe("setupPoiIngestCron", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetPoiIngestTestMocks();
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
