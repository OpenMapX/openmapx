import type { Counter, Histogram, ObservableGauge } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  AggregationTemporality,
  type CollectionResult,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import type { PoiIngestMetricsSink, PoiIngestOutcome } from "./metrics.js";
import type { PoiIngestKind } from "./types.js";

/**
 * OpenTelemetry metrics for the POI ingest pipeline.
 *
 * Mirrors the apps/api transit-metrics module so the operator UX (Prometheus
 * scrape on `/internal/metrics`, snake_case labels, cumulative temporality)
 * matches what existing dashboards already expect.
 *
 * Three instruments per plan §4.8:
 *   - `poi_ingest_runs_total` (counter): one increment per run, labelled
 *     (source_id, kind, outcome).
 *   - `poi_ingest_duration_seconds` (histogram): wall-clock run duration in
 *     seconds, labelled (source_id, kind). Histogram instead of gauge so
 *     percentiles survive cross-run aggregation.
 *   - `poi_ingest_rows` (observable gauge): the last successful row count per
 *     (source_id, kind). Gauge — not counter — because the row count is a
 *     point-in-time reading of the upstream, not a monotonic event count.
 *
 * As with apps/api, no labels carry user input. `source_id` and `kind` come
 * from a closed registry; `outcome` is the closed enum on PoiIngestOutcome.
 */

const METER_NAME = "openmapx-poi-ingest";

class CollectablePoiMetricReader extends MetricReader {
  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  protected async onForceFlush(): Promise<void> {
    // No-op: collection is pull-driven via `snapshot()`.
  }

  protected async onShutdown(): Promise<void> {
    // No-op.
  }

  async snapshot(): Promise<CollectionResult> {
    return this.collect();
  }
}

interface RowCountKey {
  sourceId: string;
  kind: PoiIngestKind;
}

function keyFor(labels: RowCountKey): string {
  return `${labels.sourceId}|${labels.kind}`;
}

export interface PoiMetricsHandle {
  meterProvider: MeterProvider;
  reader: CollectablePoiMetricReader;
  runsCounter: Counter;
  durationHistogram: Histogram;
  rowGauge: ObservableGauge;
  /** Render the current metric state as Prometheus text. */
  renderPrometheus(): Promise<string>;
  /** Shut the meter provider down (idempotent). */
  close(): Promise<void>;
  /** Internal: update the last-observed row count for the gauge callback. */
  setRowCount(labels: RowCountKey, count: number): void;
}

let singleton: PoiMetricsHandle | null = null;

export function initPoiMetrics(): PoiMetricsHandle {
  if (singleton) return singleton;

  const reader = new CollectablePoiMetricReader();
  // Per-process meter provider — distinct from any global OTEL setup the host
  // may have so the Prometheus output stays scoped to POI ingest. We
  // deliberately do NOT call `metrics.setGlobalMeterProvider` here; the
  // transit pipeline already owns the global slot in apps/api, and
  // data-manager has no other OTEL consumer.
  const meterProvider = new MeterProvider({ readers: [reader] });
  const meter = meterProvider.getMeter(METER_NAME);

  const runsCounter = meter.createCounter("poi_ingest_runs_total", {
    description: "Total POI ingest runs by source/kind/outcome",
  });
  const durationHistogram = meter.createHistogram("poi_ingest_duration_seconds", {
    description: "POI ingest run duration in seconds",
    unit: "s",
  });

  // ObservableGauge is the right primitive for "last successful row count".
  // We hold the latest reading per (source, kind) in a Map; the callback
  // emits one observation per key on each scrape.
  const lastRowCounts = new Map<string, { labels: RowCountKey; count: number }>();
  const rowGauge = meter.createObservableGauge("poi_ingest_rows", {
    description: "Last successful row count per POI source/kind",
  });
  rowGauge.addCallback((observer) => {
    for (const entry of lastRowCounts.values()) {
      observer.observe(entry.count, toPromLabels(entry.labels));
    }
  });

  const serializer = new PrometheusSerializer();

  async function renderPrometheus(): Promise<string> {
    const collected = await reader.snapshot();
    if (collected.errors.length > 0) {
      // Surface but do not throw — partial collection is fine for scraping.
      // eslint-disable-next-line no-console
      console.warn("poi-metrics: collection errors", collected.errors);
    }
    return serializer.serialize(collected.resourceMetrics);
  }

  async function close(): Promise<void> {
    await meterProvider.shutdown();
    singleton = null;
  }

  function setRowCount(labels: RowCountKey, count: number): void {
    lastRowCounts.set(keyFor(labels), { labels, count });
  }

  singleton = {
    meterProvider,
    reader,
    runsCounter,
    durationHistogram,
    rowGauge,
    renderPrometheus,
    close,
    setRowCount,
  };
  return singleton;
}

export function getPoiMetrics(): PoiMetricsHandle {
  return singleton ?? initPoiMetrics();
}

/** Test-only reset. Production code never calls this. */
export async function resetPoiMetricsForTests(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/**
 * Translate camelCase labels into Prometheus snake_case. Matches the
 * convention used by apps/api (provider_id, method, outcome) so Grafana
 * panels can re-use label selectors across both pipelines.
 */
function toPromLabels(labels: {
  sourceId: string;
  kind: PoiIngestKind;
  outcome?: PoiIngestOutcome;
}): Record<string, string> {
  const out: Record<string, string> = {
    source_id: labels.sourceId,
    kind: labels.kind,
  };
  if (labels.outcome !== undefined) out.outcome = labels.outcome;
  return out;
}

/**
 * Build a `PoiIngestMetricsSink` backed by the OTEL pipeline above. Callers
 * who want both log lines AND OTEL counters wrap this with a fan-out sink
 * (see `combineMetricsSinks`).
 */
export function createOtelMetricsSink(
  handle: PoiMetricsHandle = getPoiMetrics(),
): PoiIngestMetricsSink {
  return {
    recordRun(labels) {
      handle.runsCounter.add(1, toPromLabels(labels));
    },
    recordDuration(labels, seconds) {
      handle.durationHistogram.record(seconds, toPromLabels(labels));
    },
    recordRowCount(labels, count) {
      handle.setRowCount(labels, count);
    },
  };
}

/**
 * Fan-out helper: every call dispatches to each sink in order. Errors in one
 * sink are swallowed so they cannot starve the others — metrics are
 * best-effort by design.
 */
export function combineMetricsSinks(...sinks: PoiIngestMetricsSink[]): PoiIngestMetricsSink {
  return {
    recordRun(labels) {
      for (const s of sinks) {
        try {
          s.recordRun(labels);
        } catch {
          // ignore — metrics must not throw
        }
      }
    },
    recordDuration(labels, seconds) {
      for (const s of sinks) {
        try {
          s.recordDuration(labels, seconds);
        } catch {
          // ignore
        }
      }
    },
    recordRowCount(labels, count) {
      for (const s of sinks) {
        try {
          s.recordRowCount(labels, count);
        } catch {
          // ignore
        }
      }
    },
  };
}
