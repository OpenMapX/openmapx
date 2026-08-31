import "./support/poi-ingest-environment.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBootstrap } from "../../src/jobs/poi-ingest/bootstrap.js";
import { noopMetricsSink } from "../../src/jobs/poi-ingest/metrics.js";
import { createPoiSingleFlight } from "../../src/jobs/poi-ingest/single-flight.js";
import type { PoiJobLogger } from "../../src/jobs/poi-ingest/types.js";
import {
  bundledPoiSource as bundledSource,
  fakePoiRedis as fakeRedis,
  fakePoiSql as fakeSql,
  getPoiIngestTestMocks,
  makePoiIngestResult as makeOkResult,
  resetPoiIngestTestMocks,
  staticLivePoiSource as staticLiveSource,
  staticPoiSource as staticSource,
} from "./support/poi-ingest-environment.js";

const {
  createPoiJobRowMock,
  getLastPoiFeedStateMock,
  runBundledIngestMock,
  runLiveIngestMock,
  runStaticIngestMock,
} = getPoiIngestTestMocks();

function makeJobLogger(): PoiJobLogger & {
  calls: { level: "info" | "warn" | "error" | "debug"; msg: string; extra?: unknown }[];
} {
  const calls: { level: "info" | "warn" | "error" | "debug"; msg: string; extra?: unknown }[] = [];
  return {
    calls,
    info: (msg, extra) => calls.push({ level: "info", msg, extra }),
    warn: (msg, extra) => calls.push({ level: "warn", msg, extra }),
    error: (msg, extra) => calls.push({ level: "error", msg, extra }),
    debug: (msg, extra) => calls.push({ level: "debug", msg, extra }),
  };
}

function runSingleStaticBootstrap(singleFlight = createPoiSingleFlight()) {
  return runBootstrap({
    sql: fakeSql(),
    redis: fakeRedis(),
    singleFlight,
    metricsSink: noopMetricsSink,
    logger: makeJobLogger(),
    sources: [staticSource("src-1")],
  });
}

describe("runBootstrap", () => {
  beforeEach(() => {
    resetPoiIngestTestMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero counts on an empty registry", async () => {
    const result = await runBootstrap({
      sql: fakeSql(),
      redis: fakeRedis(),
      singleFlight: createPoiSingleFlight(),
      metricsSink: noopMetricsSink,
      logger: makeJobLogger(),
      sources: [],
    });
    expect(result).toEqual({ scanned: 0, triggered: 0, skipped: 0, errors: 0 });
    expect(runStaticIngestMock).not.toHaveBeenCalled();
  });

  it("triggers static-only for a cold source and skips a warm one", async () => {
    runStaticIngestMock.mockResolvedValue(makeOkResult("cold", "static"));
    getLastPoiFeedStateMock.mockImplementation(async (id) =>
      id === "warm"
        ? {
            lastStaticHash: "h1",
            lastStaticRowCount: 10,
            lastStaticIngestAt: new Date("2026-01-01T00:00:00Z"),
            consecutiveFailures: 0,
            status: "active",
          }
        : undefined,
    );

    const result = await runBootstrap({
      sql: fakeSql(),
      redis: fakeRedis(),
      singleFlight: createPoiSingleFlight(),
      metricsSink: noopMetricsSink,
      logger: makeJobLogger(),
      sources: [staticSource("cold"), staticSource("warm")],
    });

    expect(result).toEqual({ scanned: 2, triggered: 1, skipped: 1, errors: 0 });
    expect(runStaticIngestMock).toHaveBeenCalledTimes(1);
    expect(createPoiJobRowMock).toHaveBeenCalledTimes(1);
    const createArg = createPoiJobRowMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(createArg).toMatchObject({
      sourceId: "cold",
      kind: "static",
      triggeredBy: "bootstrap",
    });
    expect((createArg?.metadata as Record<string, unknown>)?.bootstrapReason).toBe("cold-static");
  });

  it("triggers bundled for a cold bundled source", async () => {
    runBundledIngestMock.mockResolvedValue(makeOkResult("bundled-1", "bundled"));
    const result = await runBootstrap({
      sql: fakeSql(),
      redis: fakeRedis(),
      singleFlight: createPoiSingleFlight(),
      metricsSink: noopMetricsSink,
      logger: makeJobLogger(),
      sources: [bundledSource("bundled-1")],
    });
    expect(result).toEqual({ scanned: 1, triggered: 1, skipped: 0, errors: 0 });
    expect(runBundledIngestMock).toHaveBeenCalledTimes(1);
    expect(runStaticIngestMock).not.toHaveBeenCalled();
    const createArg = createPoiJobRowMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect((createArg?.metadata as Record<string, unknown>)?.bootstrapReason).toBe("cold-bundled");
  });

  it("triggers both static and live for a cold static+live source", async () => {
    runStaticIngestMock.mockResolvedValue(makeOkResult("src-1", "static"));
    runLiveIngestMock.mockResolvedValue(makeOkResult("src-1", "live"));
    const result = await runBootstrap({
      sql: fakeSql(),
      redis: fakeRedis(),
      singleFlight: createPoiSingleFlight(),
      metricsSink: noopMetricsSink,
      logger: makeJobLogger(),
      sources: [staticLiveSource("src-1")],
    });
    expect(result).toEqual({ scanned: 1, triggered: 2, skipped: 0, errors: 0 });
    expect(runStaticIngestMock).toHaveBeenCalledTimes(1);
    expect(runLiveIngestMock).toHaveBeenCalledTimes(1);
    // Static must precede live so the live merge sees a populated table.
    expect(runStaticIngestMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      runLiveIngestMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("counts a single-flight collision as a skip", async () => {
    const singleFlight = createPoiSingleFlight();
    // Cron beat us to it.
    singleFlight.tryAcquire("src-1", "static");

    const result = await runSingleStaticBootstrap(singleFlight);

    expect(result).toEqual({ scanned: 1, triggered: 0, skipped: 1, errors: 0 });
    expect(runStaticIngestMock).not.toHaveBeenCalled();
    expect(createPoiJobRowMock).not.toHaveBeenCalled();
  });

  it("counts a pipeline failure as an error and releases the lock", async () => {
    runStaticIngestMock.mockRejectedValue(new Error("upstream 500"));
    const singleFlight = createPoiSingleFlight();
    const result = await runSingleStaticBootstrap(singleFlight);
    expect(result).toEqual({ scanned: 1, triggered: 0, skipped: 0, errors: 1 });
    // Lock released — runOneAndPersist's finally block ran.
    const reacquire = singleFlight.tryAcquire("src-1", "static");
    expect(reacquire.ok).toBe(true);
  });

  it("counts a createPoiJobRow failure as an error and releases the lock", async () => {
    createPoiJobRowMock.mockRejectedValue(new Error("db down"));
    const singleFlight = createPoiSingleFlight();
    const result = await runSingleStaticBootstrap(singleFlight);
    expect(result).toEqual({ scanned: 1, triggered: 0, skipped: 0, errors: 1 });
    expect(runStaticIngestMock).not.toHaveBeenCalled();
    const reacquire = singleFlight.tryAcquire("src-1", "static");
    expect(reacquire.ok).toBe(true);
  });

  it("a feed-state read failure does not block other sources", async () => {
    runStaticIngestMock.mockResolvedValue(makeOkResult("good", "static"));
    getLastPoiFeedStateMock.mockImplementation(async (id) => {
      if (id === "bad") throw new Error("read failed");
      return undefined;
    });

    const result = await runBootstrap({
      sql: fakeSql(),
      redis: fakeRedis(),
      singleFlight: createPoiSingleFlight(),
      metricsSink: noopMetricsSink,
      logger: makeJobLogger(),
      sources: [staticSource("bad"), staticSource("good")],
    });

    expect(result).toEqual({ scanned: 2, triggered: 1, skipped: 0, errors: 1 });
    expect(runStaticIngestMock).toHaveBeenCalledTimes(1);
  });
});
