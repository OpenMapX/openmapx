import type { PoiIngestKind, PoiIngestResult, PoiJobLogger } from "./types.js";

export type PoiIngestOutcome = "ok" | "partial" | "skipped" | "error";

export interface PoiIngestMetricsSink {
  /** One increment per run with the final outcome. */
  recordRun(labels: { sourceId: string; kind: PoiIngestKind; outcome: PoiIngestOutcome }): void;
  /** Wall-clock duration of the run in seconds. */
  recordDuration(labels: { sourceId: string; kind: PoiIngestKind }, seconds: number): void;
  /** Most recent row count per (sourceId, kind). */
  recordRowCount(labels: { sourceId: string; kind: PoiIngestKind }, count: number): void;
}

/**
 * Default sink: emits one structured log line per signal. Future PRs can swap
 * this for an OTEL-backed sink once data-manager grows a metrics endpoint —
 * the `PoiIngestMetricsSink` interface stays stable.
 */
export function createLogMetricsSink(logger: PoiJobLogger): PoiIngestMetricsSink {
  return {
    recordRun(labels) {
      logger.info("poi-ingest.metrics.run", labels);
    },
    recordDuration(labels, seconds) {
      logger.info("poi-ingest.metrics.duration_seconds", { ...labels, seconds });
    },
    recordRowCount(labels, count) {
      logger.info("poi-ingest.metrics.row_count", { ...labels, count });
    },
  };
}

/** No-op sink for tests / when metrics are off. */
export const noopMetricsSink: PoiIngestMetricsSink = {
  recordRun: () => {},
  recordDuration: () => {},
  recordRowCount: () => {},
};

/**
 * Apply a completed ingest run to the sink. Derives all three signals from
 * the result envelope and is called once per run by the cron/HTTP entrypoints
 * (B2/B4) right after `upsertPoiFeedState`.
 *
 * Row counts: for bundled runs the `kind` label already says "combined"; we
 * emit a single `recordRowCount` call preferring the static row count
 * (authoritative on a successful swap) and falling back to the live row
 * count. The call is skipped entirely when both row counts are undefined.
 */
export function recordRunToSink(sink: PoiIngestMetricsSink, result: PoiIngestResult): void {
  const labels = { sourceId: result.sourceId, kind: result.kind };
  sink.recordRun({ ...labels, outcome: result.status });
  sink.recordDuration(labels, result.durationMs / 1000);
  const rowCount = result.staticRowCount ?? result.liveRowCount;
  if (rowCount !== undefined) {
    sink.recordRowCount(labels, rowCount);
  }
}
