import { describe, expect, it } from "vitest";
import {
  createLogMetricsSink,
  noopMetricsSink,
  type PoiIngestMetricsSink,
  recordRunToSink,
} from "../../src/jobs/poi-ingest/metrics.js";
import type { PoiIngestResult, PoiJobLogger } from "../../src/jobs/poi-ingest/types.js";

function makeLogger(): PoiJobLogger & {
  infos: Array<[string, Record<string, unknown> | undefined]>;
  warns: Array<[string, Record<string, unknown> | undefined]>;
} {
  const infos: Array<[string, Record<string, unknown> | undefined]> = [];
  const warns: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    info: (msg, extra) => infos.push([msg, extra]),
    warn: (msg, extra) => warns.push([msg, extra]),
    error: () => {},
    debug: () => {},
    infos,
    warns,
  };
}

function makeRecordingSink(): {
  sink: PoiIngestMetricsSink;
  runs: Array<{ sourceId: string; kind: string; outcome: string }>;
  durations: Array<{ sourceId: string; kind: string; seconds: number }>;
  rowCounts: Array<{ sourceId: string; kind: string; count: number }>;
} {
  const runs: Array<{ sourceId: string; kind: string; outcome: string }> = [];
  const durations: Array<{ sourceId: string; kind: string; seconds: number }> = [];
  const rowCounts: Array<{ sourceId: string; kind: string; count: number }> = [];
  return {
    sink: {
      recordRun: (labels) => runs.push(labels),
      recordDuration: (labels, seconds) => durations.push({ ...labels, seconds }),
      recordRowCount: (labels, count) => rowCounts.push({ ...labels, count }),
    },
    runs,
    durations,
    rowCounts,
  };
}

function baseResult(overrides: Partial<PoiIngestResult> = {}): PoiIngestResult {
  return {
    sourceId: "src",
    kind: "static",
    startedAt: "2026-05-24T00:00:00.000Z",
    finishedAt: "2026-05-24T00:00:01.000Z",
    durationMs: 2500,
    status: "ok",
    stages: [],
    staticRowCount: 100,
    ...overrides,
  };
}

describe("createLogMetricsSink", () => {
  it("emits one log line per signal with structured labels", () => {
    const logger = makeLogger();
    const sink = createLogMetricsSink(logger);

    sink.recordRun({ sourceId: "src", kind: "static", outcome: "ok" });
    sink.recordDuration({ sourceId: "src", kind: "static" }, 1.5);
    sink.recordRowCount({ sourceId: "src", kind: "static" }, 42);

    expect(logger.infos).toEqual([
      ["poi-ingest.metrics.run", { sourceId: "src", kind: "static", outcome: "ok" }],
      ["poi-ingest.metrics.duration_seconds", { sourceId: "src", kind: "static", seconds: 1.5 }],
      ["poi-ingest.metrics.row_count", { sourceId: "src", kind: "static", count: 42 }],
    ]);
  });
});

describe("noopMetricsSink", () => {
  it("is callable but produces no observable side effects", () => {
    expect(() => {
      noopMetricsSink.recordRun({ sourceId: "src", kind: "static", outcome: "ok" });
      noopMetricsSink.recordDuration({ sourceId: "src", kind: "static" }, 1);
      noopMetricsSink.recordRowCount({ sourceId: "src", kind: "static" }, 1);
    }).not.toThrow();
  });
});

describe("recordRunToSink", () => {
  it("maps result.status straight to outcome and emits all three signals on success", () => {
    const { sink, runs, durations, rowCounts } = makeRecordingSink();
    recordRunToSink(sink, baseResult({ status: "ok", staticRowCount: 7, durationMs: 4000 }));

    expect(runs).toEqual([{ sourceId: "src", kind: "static", outcome: "ok" }]);
    expect(durations).toEqual([{ sourceId: "src", kind: "static", seconds: 4 }]);
    expect(rowCounts).toEqual([{ sourceId: "src", kind: "static", count: 7 }]);
  });

  it("propagates 'partial' / 'skipped' / 'error' outcomes verbatim", () => {
    const outcomes: Array<PoiIngestResult["status"]> = ["partial", "skipped", "error"];
    for (const status of outcomes) {
      const { sink, runs } = makeRecordingSink();
      recordRunToSink(sink, baseResult({ status }));
      expect(runs[0]?.outcome).toBe(status);
    }
  });

  it("prefers staticRowCount over liveRowCount for bundled runs", () => {
    const { sink, rowCounts } = makeRecordingSink();
    recordRunToSink(sink, baseResult({ kind: "bundled", staticRowCount: 200, liveRowCount: 50 }));
    expect(rowCounts).toEqual([{ sourceId: "src", kind: "bundled", count: 200 }]);
  });

  it("falls back to liveRowCount when staticRowCount is undefined", () => {
    const { sink, rowCounts } = makeRecordingSink();
    recordRunToSink(
      sink,
      baseResult({ kind: "live", staticRowCount: undefined, liveRowCount: 12 }),
    );
    expect(rowCounts).toEqual([{ sourceId: "src", kind: "live", count: 12 }]);
  });

  it("skips the row-count call entirely when both row counts are undefined", () => {
    const { sink, runs, durations, rowCounts } = makeRecordingSink();
    recordRunToSink(sink, baseResult({ staticRowCount: undefined, liveRowCount: undefined }));
    expect(runs).toHaveLength(1);
    expect(durations).toHaveLength(1);
    expect(rowCounts).toHaveLength(0);
  });
});
