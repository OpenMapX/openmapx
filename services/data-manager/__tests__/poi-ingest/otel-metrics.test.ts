import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordRunToSink } from "../../src/jobs/poi-ingest/metrics.js";
import {
  combineMetricsSinks,
  createOtelMetricsSink,
  getPoiMetrics,
  initPoiMetrics,
  resetPoiMetricsForTests,
} from "../../src/jobs/poi-ingest/otel-metrics.js";
import type { PoiIngestResult } from "../../src/jobs/poi-ingest/types.js";

const NOW_ISO = "2026-05-24T12:00:00.000Z";

function fakeResult(overrides: Partial<PoiIngestResult> = {}): PoiIngestResult {
  return {
    sourceId: "bnetza-ev",
    kind: "static",
    startedAt: NOW_ISO,
    finishedAt: NOW_ISO,
    durationMs: 1234,
    status: "ok",
    stages: [],
    staticRowCount: 65_000,
    ...overrides,
  };
}

describe("OTEL POI metrics sink", () => {
  beforeEach(() => {
    initPoiMetrics();
  });
  afterEach(async () => {
    await resetPoiMetricsForTests();
  });

  it("renders counter increments in Prometheus output", async () => {
    const sink = createOtelMetricsSink();
    recordRunToSink(sink, fakeResult({ status: "ok" }));
    recordRunToSink(sink, fakeResult({ status: "error", staticRowCount: undefined }));

    const out = await getPoiMetrics().renderPrometheus();
    expect(out).toContain("poi_ingest_runs_total");
    expect(out).toMatch(/source_id="bnetza-ev"/);
    expect(out).toMatch(/kind="static"/);
    expect(out).toMatch(/outcome="ok"/);
    expect(out).toMatch(/outcome="error"/);
  });

  it("renders histogram observations for durations", async () => {
    const sink = createOtelMetricsSink();
    recordRunToSink(sink, fakeResult({ durationMs: 500 }));
    recordRunToSink(sink, fakeResult({ durationMs: 1500 }));

    const out = await getPoiMetrics().renderPrometheus();
    expect(out).toContain("poi_ingest_duration_seconds");
    // Histogram emits bucket lines and a sum line; sanity check we got at
    // least one bucket and the sum reflects both samples (~2.0s total).
    expect(out).toMatch(/poi_ingest_duration_seconds_bucket\{/);
    expect(out).toMatch(/poi_ingest_duration_seconds_sum\{[^}]+\} 2\b/);
  });

  it("exposes the last row count as a gauge per (source, kind)", async () => {
    const sink = createOtelMetricsSink();
    recordRunToSink(sink, fakeResult({ sourceId: "bnetza-ev", staticRowCount: 65_000 }));
    recordRunToSink(sink, fakeResult({ sourceId: "bnetza-ev", staticRowCount: 65_100 }));
    recordRunToSink(
      sink,
      fakeResult({ sourceId: "switzerland-ev", kind: "static", staticRowCount: 9_000 }),
    );

    const out = await getPoiMetrics().renderPrometheus();
    expect(out).toContain("poi_ingest_rows");
    // The second bnetza run overwrites the gauge — last-write-wins is the
    // contract for "last successful row count".
    expect(out).toMatch(/poi_ingest_rows\{[^}]*source_id="bnetza-ev"[^}]*\} 65100\b/);
    expect(out).toMatch(/poi_ingest_rows\{[^}]*source_id="switzerland-ev"[^}]*\} 9000\b/);
  });

  it("skips row-count emission when the result has neither static nor live count", async () => {
    const sink = createOtelMetricsSink();
    recordRunToSink(
      sink,
      fakeResult({
        status: "error",
        staticRowCount: undefined,
        liveRowCount: undefined,
      }),
    );
    const out = await getPoiMetrics().renderPrometheus();
    // Counter + duration emit even on error; gauge stays empty.
    expect(out).toContain("poi_ingest_runs_total");
    expect(out).not.toMatch(/poi_ingest_rows\{[^}]*source_id="bnetza-ev"/);
  });

  it("combineMetricsSinks fans out to every wrapped sink", () => {
    const calls: string[] = [];
    const a = {
      recordRun: () => calls.push("a-run"),
      recordDuration: () => calls.push("a-dur"),
      recordRowCount: () => calls.push("a-rows"),
    };
    const b = {
      recordRun: () => calls.push("b-run"),
      recordDuration: () => calls.push("b-dur"),
      recordRowCount: () => calls.push("b-rows"),
    };
    const sink = combineMetricsSinks(a, b);
    sink.recordRun({ sourceId: "x", kind: "static", outcome: "ok" });
    sink.recordDuration({ sourceId: "x", kind: "static" }, 1);
    sink.recordRowCount({ sourceId: "x", kind: "static" }, 1);
    expect(calls).toEqual(["a-run", "b-run", "a-dur", "b-dur", "a-rows", "b-rows"]);
  });

  it("combineMetricsSinks swallows errors so one bad sink can't starve others", () => {
    const calls: string[] = [];
    const bad = {
      recordRun: () => {
        throw new Error("boom");
      },
      recordDuration: () => {
        throw new Error("boom");
      },
      recordRowCount: () => {
        throw new Error("boom");
      },
    };
    const good = {
      recordRun: () => calls.push("good-run"),
      recordDuration: () => calls.push("good-dur"),
      recordRowCount: () => calls.push("good-rows"),
    };
    const sink = combineMetricsSinks(bad, good);
    expect(() => sink.recordRun({ sourceId: "x", kind: "static", outcome: "ok" })).not.toThrow();
    expect(() => sink.recordDuration({ sourceId: "x", kind: "static" }, 1)).not.toThrow();
    expect(() => sink.recordRowCount({ sourceId: "x", kind: "static" }, 1)).not.toThrow();
    expect(calls).toEqual(["good-run", "good-dur", "good-rows"]);
  });
});
