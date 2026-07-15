import { type Counter, type Histogram, metrics } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  AggregationTemporality,
  type CollectionResult,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";

/**
 * OpenTelemetry metrics for the transit provider chain.
 *
 * Two instruments:
 *   - `transit_provider_calls_total` (counter): one increment per provider
 *     call, labelled with provider id, orchestrator method, and outcome.
 *   - `transit_provider_call_duration_ms` (histogram): the per-call latency
 *     in milliseconds, same labels.
 *
 * The exporter is the Prometheus text format, served at `/api/internal/metrics`
 * by Fastify. The endpoint is intended to be reachable only from inside the
 * Docker network — Prometheus scrapes are aggregate counters and contain no
 * PII, but a publicly accessible `/metrics` endpoint still leaks operational
 * detail (provider catalogue, request volume) so we keep it internal-only.
 *
 * No labels carry user input. `providerId`, `method`, and `outcome` are all
 * drawn from a closed enumeration declared by the orchestrator.
 */

const METER_NAME = "openmapx-transit";

/**
 * MetricReader subclass that exposes the collected snapshot on demand. The
 * stock PrometheusExporter spins up its own HTTP server, which conflicts with
 * Fastify's port + auth model — we want to serve `/metrics` on the same port
 * as the rest of the API so it inherits the existing helmet/cors stack.
 */
class CollectableMetricReader extends MetricReader {
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

export interface MetricsHandle {
  meterProvider: MeterProvider;
  reader: CollectableMetricReader;
  providerCallCounter: Counter;
  providerCallLatency: Histogram;
  transitDecisionCounter: Counter;
  /** Render the current metric state as Prometheus text format. */
  renderPrometheus(): Promise<string>;
  /** Shut the meter provider down (idempotent). */
  close(): Promise<void>;
}

let singleton: MetricsHandle | null = null;

/**
 * Initialise the OpenTelemetry metrics pipeline. Idempotent: subsequent calls
 * return the same handle so the orchestrator and the Fastify route share a
 * single MeterProvider. Tests can reset between cases via `resetMetricsForTests`.
 */
export function initMetrics(): MetricsHandle {
  if (singleton) return singleton;

  const reader = new CollectableMetricReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);
  const meter = meterProvider.getMeter(METER_NAME);

  const providerCallCounter = meter.createCounter("transit_provider_calls_total", {
    description: "Total transit provider calls by id/method/outcome",
  });
  const providerCallLatency = meter.createHistogram("transit_provider_call_duration_ms", {
    description: "Transit provider call duration in milliseconds",
    unit: "ms",
  });
  const transitDecisionCounter = meter.createCounter("transit_provider_decisions_total", {
    description: "Bounded transit orchestration decisions and avoided calls",
  });

  const serializer = new PrometheusSerializer();

  async function renderPrometheus(): Promise<string> {
    const collected = await reader.snapshot();
    if (collected.errors.length > 0) {
      // Surface but do not throw — partial collection is fine for scraping.
      // eslint-disable-next-line no-console
      console.warn("metrics: collection errors", collected.errors);
    }
    return serializer.serialize(collected.resourceMetrics);
  }

  async function close(): Promise<void> {
    await meterProvider.shutdown();
    singleton = null;
  }

  singleton = {
    meterProvider,
    reader,
    providerCallCounter,
    providerCallLatency,
    transitDecisionCounter,
    renderPrometheus,
    close,
  };
  return singleton;
}

/**
 * Access the metrics handle, initialising on first call. Code paths that
 * want to bump counters should call this rather than `initMetrics()` directly
 * — it makes the lazy-init pattern explicit at the call site.
 */
export function getMetrics(): MetricsHandle {
  return singleton ?? initMetrics();
}

/**
 * Record a single provider call. Wraps the counter + histogram into one helper
 * so callers cannot forget one or the other.
 */
export interface ProviderCallLabels {
  providerId: string;
  method: string;
  outcome: "ok" | "empty" | "error" | "skipped";
}

/**
 * Translate the orchestrator's camelCase labels into Prometheus's snake_case
 * convention. Snake_case is the convention every Grafana panel + alerting
 * expression in `infra/docker/dashboards/` assumes, and rewriting at the
 * recording boundary keeps the consumer code idiomatic.
 */
function toPromLabels(labels: ProviderCallLabels): Record<string, string> {
  return {
    provider_id: labels.providerId,
    method: labels.method,
    outcome: labels.outcome,
  };
}

export function recordProviderCall(labels: ProviderCallLabels, latencyMs: number): void {
  const handle = getMetrics();
  const promLabels = toPromLabels(labels);
  handle.providerCallCounter.add(1, promLabels);
  handle.providerCallLatency.record(latencyMs, promLabels);
}

export interface TransitDecisionLabels {
  operation: "plan" | "routes" | "refresh" | "realtime";
  providerId: string;
  role: "baseline" | "fallback" | "enrichment" | "regional" | "none";
  reason:
    | "selected"
    | "authoritative_empty"
    | "transport_failure"
    | "unsupported"
    | "refresh_success"
    | "refresh_fallback"
    | "realtime_complete";
}

export function recordTransitDecision(labels: TransitDecisionLabels, value = 1): void {
  getMetrics().transitDecisionCounter.add(value, {
    operation: labels.operation,
    provider_id: labels.providerId,
    role: labels.role,
    reason: labels.reason,
  });
}

/** Test-only reset. Production code never calls this. */
export async function resetMetricsForTests(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
