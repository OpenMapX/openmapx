import type {
  AirQualityMetrics,
  AirQualityProviderCallMetrics,
  AirQualityRasterMetrics,
} from "@openmapx/integration-framework";
import { type Counter, type Histogram, metrics } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  AggregationTemporality,
  type CollectionResult,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";

/**
 * OpenTelemetry metrics for the transit and routing provider chains.
 *
 * Two instruments:
 *   - `transit_provider_calls_total` (counter): one increment per provider
 *     call, labelled with provider id, orchestrator method, and outcome.
 *   - `transit_provider_call_duration_ms` (histogram): the per-call latency
 *     in milliseconds, same labels.
 *   - `routing_requests_total` / `routing_request_duration_ms`: end-to-end
 *     directions and optimize request outcomes and latency.
 *   - `routing_route_count` / `routing_alternate_count`: returned route
 *     counts, split by traffic mode and operation.
 *   - `routing_traffic_delay_seconds` and `routing_baseline_available_total`:
 *     live-vs-baseline recosting coverage and delta.
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
  override selectAggregationTemporality(): AggregationTemporality {
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
  transitReachabilityCounter: Counter;
  transitReachabilityLatency: Histogram;
  transitReachabilitySeedCount: Histogram;
  transitReachabilityDestinationCount: Histogram;
  transitReachabilityBatchCount: Histogram;
  transitReachabilityGridMetres: Histogram;
  routingRequestCounter: Counter;
  routingRequestLatency: Histogram;
  routingRouteCount: Histogram;
  routingAlternateCount: Histogram;
  routingTrafficDelay: Histogram;
  routingBaselineCounter: Counter;
  osmContributionCounter: Counter;
  osmContributionLatency: Histogram;
  personalTimelineRequestCounter: Counter;
  personalTimelineRequestLatency: Histogram;
  airQualityRequestCounter: Counter;
  airQualityRequestLatency: Histogram;
  airQualityEvidenceCount: Histogram;
  airQualityProviderCallCounter: Counter;
  airQualityProviderCallLatency: Histogram;
  airQualityRasterAge: Histogram;
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
  const transitReachabilityCounter = meter.createCounter("transit_reachability_requests_total", {
    description: "Transit reachability requests by bounded capability and outcome labels",
  });
  const transitReachabilityLatency = meter.createHistogram(
    "transit_reachability_request_duration_ms",
    { description: "Transit reachability request duration", unit: "ms" },
  );
  const transitReachabilitySeedCount = meter.createHistogram("transit_reachability_seed_count", {
    description: "Raw or thinned transit reachability seed count",
  });
  const transitReachabilityDestinationCount = meter.createHistogram(
    "transit_reachability_destination_count",
    { description: "Exact transit reachability destination count" },
  );
  const transitReachabilityBatchCount = meter.createHistogram("transit_reachability_batch_count", {
    description: "Exact transit reachability sequential batch count",
  });
  const transitReachabilityGridMetres = meter.createHistogram("transit_reachability_grid_metres", {
    description: "Estimated surface thinning grid size",
    unit: "m",
  });
  const routingRequestCounter = meter.createCounter("routing_requests_total", {
    description: "End-to-end routing requests by operation, provider, and outcome",
  });
  const routingRequestLatency = meter.createHistogram("routing_request_duration_ms", {
    description: "End-to-end routing request duration in milliseconds",
    unit: "ms",
  });
  const routingRouteCount = meter.createHistogram("routing_route_count", {
    description: "Number of routes returned by a routing request",
  });
  const routingAlternateCount = meter.createHistogram("routing_alternate_count", {
    description: "Number of alternate routes returned by a routing request",
  });
  const routingTrafficDelay = meter.createHistogram("routing_traffic_delay_seconds", {
    description: "Live route duration minus its recosted baseline duration",
    unit: "s",
  });
  const routingBaselineCounter = meter.createCounter("routing_baseline_available_total", {
    description: "Routing requests whose active route had a finite baseline duration",
  });
  const personalTimelineRequestCounter = meter.createCounter("personal_timeline_requests_total", {
    description: "Personal timeline requests by bounded mode, operation, and outcome",
  });
  const personalTimelineRequestLatency = meter.createHistogram(
    "personal_timeline_request_duration_ms",
    {
      description: "Personal timeline request duration in milliseconds",
      unit: "ms",
    },
  );
  const airQualityRequestCounter = meter.createCounter("air_quality_requests_total", {
    description: "Canonical air-quality requests with bounded outcome and provenance labels",
  });
  const airQualityRequestLatency = meter.createHistogram("air_quality_request_duration_ms", {
    description: "Canonical air-quality request duration",
    unit: "ms",
  });
  const airQualityEvidenceCount = meter.createHistogram("air_quality_evidence_count", {
    description: "Number of evidence records returned by a canonical request",
  });
  const airQualityProviderCallCounter = meter.createCounter("air_quality_provider_calls_total", {
    description: "Air-quality provider calls and bounded preflight suppressions",
  });
  const airQualityProviderCallLatency = meter.createHistogram(
    "air_quality_provider_call_duration_ms",
    { description: "Air-quality provider call duration", unit: "ms" },
  );
  const airQualityRasterAge = meter.createHistogram("air_quality_raster_age_seconds", {
    description: "Age of a served air-quality raster frame",
    unit: "s",
  });

  const osmContributionCounter = meter.createCounter("osm_contribution_operations_total", {
    description: "OpenStreetMap contribution operations by operation and outcome",
  });
  const osmContributionLatency = meter.createHistogram("osm_contribution_operation_duration_ms", {
    description: "OpenStreetMap contribution operation duration in milliseconds",
    unit: "ms",
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
    transitReachabilityCounter,
    transitReachabilityLatency,
    transitReachabilitySeedCount,
    transitReachabilityDestinationCount,
    transitReachabilityBatchCount,
    transitReachabilityGridMetres,
    routingRequestCounter,
    routingRequestLatency,
    routingRouteCount,
    routingAlternateCount,
    routingTrafficDelay,
    routingBaselineCounter,
    osmContributionCounter,
    osmContributionLatency,
    personalTimelineRequestCounter,
    personalTimelineRequestLatency,
    airQualityRequestCounter,
    airQualityRequestLatency,
    airQualityEvidenceCount,
    airQualityProviderCallCounter,
    airQualityProviderCallLatency,
    airQualityRasterAge,
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
  outcome: "ok" | "empty" | "error" | "skipped" | "timeout" | "cancelled";
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

export function recordAirQuality(metric: AirQualityMetrics): void {
  const labels = {
    method: metric.method,
    outcome: metric.outcome,
    cache_result: metric.cacheResult,
    headline_class: metric.headlineClass,
    rejection_code: metric.rejectionCode,
    quota_truncated: String(metric.quotaTruncated),
    compatibility_use: metric.compatibilityUse,
  };
  const handle = getMetrics();
  handle.airQualityRequestCounter.add(1, labels);
  handle.airQualityRequestLatency.record(Math.max(0, metric.latencyMs), labels);
  handle.airQualityEvidenceCount.record(Math.max(0, Math.floor(metric.evidenceCount)), labels);
}

function boundedProviderId(providerId: string): string {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId) ? providerId : "invalid";
}

export function recordAirQualityProviderCall(metric: AirQualityProviderCallMetrics): void {
  const labels = {
    provider_id: boundedProviderId(metric.providerId),
    method: metric.method,
    outcome: metric.outcome,
    cache_result: metric.cacheResult,
    suppression: metric.suppression,
  };
  const handle = getMetrics();
  handle.airQualityProviderCallCounter.add(1, labels);
  handle.airQualityProviderCallLatency.record(Math.max(0, metric.latencyMs), labels);
}

export function recordAirQualityRasterAge(input: AirQualityRasterMetrics): void {
  getMetrics().airQualityRasterAge.record(Math.max(0, input.ageSeconds), { state: input.state });
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

export interface TransitReachabilityMetricInput {
  operation: "capabilities" | "surface" | "exact";
  source: "self-hosted-motis" | "transitous" | "none";
  capabilityState: string;
  outcome: string;
  cacheOutcome: "hit" | "miss" | "none";
  errorKind: string;
  latencyMs: number;
  rawSeedCount?: number;
  seedCount?: number;
  gridMetres?: number;
  destinationCount?: number;
  batchCount?: number;
}

/** Record aggregate reachability telemetry; values and labels contain no coordinates or IDs. */
export function recordTransitReachability(metrics: TransitReachabilityMetricInput): void {
  const handle = getMetrics();
  const labels = {
    operation: metrics.operation,
    source: metrics.source,
    capability_state: metrics.capabilityState,
    outcome: metrics.outcome,
    cache_outcome: metrics.cacheOutcome,
    error_kind: metrics.errorKind,
  };
  handle.transitReachabilityCounter.add(1, labels);
  handle.transitReachabilityLatency.record(Math.max(0, metrics.latencyMs), labels);
  if (metrics.rawSeedCount !== undefined) {
    handle.transitReachabilitySeedCount.record(Math.max(0, metrics.rawSeedCount), {
      ...labels,
      stage: "raw",
    });
  }
  if (metrics.seedCount !== undefined) {
    handle.transitReachabilitySeedCount.record(Math.max(0, metrics.seedCount), {
      ...labels,
      stage: "thinned",
    });
  }
  if (metrics.gridMetres !== undefined) {
    handle.transitReachabilityGridMetres.record(Math.max(0, metrics.gridMetres), labels);
  }
  if (metrics.destinationCount !== undefined) {
    handle.transitReachabilityDestinationCount.record(
      Math.max(0, metrics.destinationCount),
      labels,
    );
  }
  if (metrics.batchCount !== undefined) {
    handle.transitReachabilityBatchCount.record(Math.max(0, metrics.batchCount), labels);
  }
}

export interface RoutingRequestMetrics {
  providerId: string;
  mode: string;
  operation: "directions" | "optimize";
  outcome: "ok" | "error";
  liveTraffic: boolean;
  closureAvoidance: boolean;
  latencyMs: number;
  routeCount?: number;
  alternateCount?: number;
  trafficDelaySeconds?: number;
  baselineAvailable: boolean;
}

function toRoutingPromLabels(metrics: RoutingRequestMetrics): Record<string, string> {
  return {
    provider_id: metrics.providerId,
    mode: metrics.mode,
    operation: metrics.operation,
    outcome: metrics.outcome,
    live_traffic: String(metrics.liveTraffic),
    closure_avoidance: String(metrics.closureAvoidance),
  };
}

/** Record a bounded, secret-free routing request summary for Prometheus. */
export function recordRoutingRequest(metrics: RoutingRequestMetrics): void {
  const handle = getMetrics();
  const labels = toRoutingPromLabels(metrics);
  handle.routingRequestCounter.add(1, labels);
  handle.routingRequestLatency.record(Math.max(0, metrics.latencyMs), labels);
  handle.routingBaselineCounter.add(1, {
    provider_id: metrics.providerId,
    mode: metrics.mode,
    operation: metrics.operation,
    status: metrics.baselineAvailable ? "present" : "missing",
  });

  if (metrics.routeCount !== undefined) {
    handle.routingRouteCount.record(Math.max(0, metrics.routeCount), labels);
  }
  if (metrics.alternateCount !== undefined) {
    handle.routingAlternateCount.record(Math.max(0, metrics.alternateCount), labels);
  }
  if (metrics.trafficDelaySeconds !== undefined) {
    handle.routingTrafficDelay.record(metrics.trafficDelaySeconds, labels);
  }
}

/**
 * The closed vocabulary for OpenStreetMap contribution telemetry.
 *
 * Both label sets are deliberately tiny and content-free. Nothing derived from
 * a person, an element, a field, a comment, a source, a note or a coordinate
 * may ever become a label: the whole point of this instrument is that the
 * operational signal is useful without observing what anyone contributed.
 */
export type OsmContributionMetricOperation =
  | "capabilities"
  | "context"
  | "categories"
  | "preview"
  | "publish"
  | "note"
  | "reconcile"
  | "close_changeset";

export type OsmContributionMetricOutcome =
  | "success"
  | "disabled"
  | "invalid"
  | "unauthorized"
  | "blocked"
  | "conflict"
  | "rate_limited"
  | "not_found"
  | "upstream_error"
  | "ambiguous";

/**
 * Record one completed contribution operation. The signature accepts only the
 * two enums and a duration — there is no arbitrary label map to widen.
 */
export function recordOsmContributionOperation(
  operation: OsmContributionMetricOperation,
  outcome: OsmContributionMetricOutcome,
  durationMs: number,
): void {
  const handle = getMetrics();
  const labels = { operation, outcome };
  handle.osmContributionCounter.add(1, labels);
  handle.osmContributionLatency.record(Math.max(0, durationMs), labels);
}

export interface PersonalTimelineRequestLabels {
  mode: "external" | "managed";
  operation: "connect" | "test" | "day";
  outcome:
    | "ok"
    | "partial"
    | "not_connected"
    | "invalid_credential"
    | "rate_limited"
    | "unavailable"
    | "invalid_response";
}

/** Record one personal-timeline operation without accepting any user-shaped labels. */
export function recordPersonalTimelineRequest(
  labels: PersonalTimelineRequestLabels,
  latencyMs: number,
): void {
  const handle = getMetrics();
  const attributes = {
    mode: labels.mode,
    operation: labels.operation,
    outcome: labels.outcome,
  };
  handle.personalTimelineRequestCounter.add(1, attributes);
  handle.personalTimelineRequestLatency.record(Math.max(0, latencyMs), attributes);
}

/** Test-only reset. Production code never calls this. */
export async function resetMetricsForTests(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
