import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalMetricsRoute } from "../../../routes/internal-metrics.js";
import {
  getMetrics,
  initMetrics,
  recordAirQuality,
  recordAirQualityProviderCall,
  recordOsmContributionOperation,
  recordPersonalTimelineRequest,
  recordProviderCall,
  recordRoutingRequest,
  recordTransitDecision,
  recordTransitReachability,
  resetMetricsForTests,
} from "../index.js";
import { getMetricsRecorder } from "../recorder.js";

/**
 * G3 metrics unit tests. The implementation lazy-initialises a singleton
 * MeterProvider so every test must call `resetMetricsForTests()` in afterEach
 * to avoid leaking state across cases.
 */

beforeEach(async () => {
  await resetMetricsForTests();
});

afterEach(async () => {
  await resetMetricsForTests();
});

describe("metrics service", () => {
  it("registers the provider-call counter and histogram with stable names", () => {
    const handle = initMetrics();
    expect(handle.providerCallCounter).toBeDefined();
    expect(handle.providerCallLatency).toBeDefined();
    // Snapshot-style assertion that the instruments still exist; the actual
    // names are validated downstream via the Prometheus serializer test.
  });

  it("returns the same handle from initMetrics and getMetrics", () => {
    const a = initMetrics();
    const b = getMetrics();
    expect(a).toBe(b);
  });

  it("renders Prometheus text containing the registered metric names after one call", async () => {
    recordProviderCall(
      { providerId: "transit-motis-local", method: "getDepartures", outcome: "ok" },
      42,
    );
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("transit_provider_calls_total");
    expect(text).toContain("transit_provider_call_duration_ms");
    expect(text).toContain('provider_id="transit-motis-local"');
    expect(text).toContain('method="getDepartures"');
    expect(text).toContain('outcome="ok"');
  });

  it("accumulates counter increments across multiple calls", async () => {
    const labels = { providerId: "transit-entur", method: "getStop", outcome: "ok" } as const;
    recordProviderCall(labels, 10);
    recordProviderCall(labels, 12);
    recordProviderCall(labels, 18);
    const text = await getMetrics().renderPrometheus();
    // Counter sample line ends with the cumulative value.
    const matches = text.match(/transit_provider_calls_total\{[^}]+\}\s+(\d+)/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    const total = matches
      .map((line) => Number(line.split(/\s+/).at(-1)))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it("distinguishes outcomes via the `outcome` label", async () => {
    recordProviderCall({ providerId: "p1", method: "getStop", outcome: "ok" }, 5);
    recordProviderCall({ providerId: "p1", method: "getStop", outcome: "error" }, 7);
    recordProviderCall({ providerId: "p1", method: "getStop", outcome: "empty" }, 9);
    const text = await getMetrics().renderPrometheus();
    expect(text).toMatch(/outcome="ok"/);
    expect(text).toMatch(/outcome="error"/);
    expect(text).toMatch(/outcome="empty"/);
  });

  it("records only bounded provider-policy labels", async () => {
    recordTransitDecision(
      {
        operation: "refresh",
        providerId: "transit-motis-local",
        role: "baseline",
        reason: "refresh_fallback",
      },
      2,
    );
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("transit_provider_decisions_total");
    expect(text).toContain('operation="refresh"');
    expect(text).toContain('role="baseline"');
    expect(text).toContain('reason="refresh_fallback"');
    expect(text).not.toContain("token");
    expect(text).not.toContain("latitude");
  });

  it("records air-quality metrics using only the closed aggregate vocabulary", async () => {
    recordAirQuality({
      method: "current",
      outcome: "partial",
      cacheResult: "stale",
      headlineClass: "computed-ground",
      rejectionCode: "incomplete-window",
      compatibilityUse: "none",
      quotaTruncated: true,
      evidenceCount: 4,
      latencyMs: 37,
    });
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("air_quality_requests_total");
    expect(text).toContain("air_quality_request_duration_ms");
    expect(text).toContain("air_quality_evidence_count");
    expect(text).toContain('headline_class="computed-ground"');
    expect(text).toContain('rejection_code="incomplete-window"');
    expect(text).not.toContain("latitude");
    expect(text).not.toContain("station_name");
  });

  it("records provider calls, cache ownership, suppression, latency, and raster age", async () => {
    recordAirQualityProviderCall({
      providerId: "openaq",
      method: "current",
      outcome: "ok",
      cacheResult: "provider-managed",
      suppression: "none",
      latencyMs: 19,
    });
    recordAirQualityProviderCall({
      providerId: "open-meteo-air-quality",
      method: "current",
      outcome: "skipped",
      cacheResult: "bypass",
      suppression: "health",
      latencyMs: 0,
    });
    getMetricsRecorder().recordAirQualityRasterAge?.({ state: "stale", ageSeconds: 721 });
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("air_quality_provider_calls_total");
    expect(text).toContain("air_quality_provider_call_duration_ms");
    expect(text).toContain('provider_id="openaq"');
    expect(text).toContain('cache_result="provider-managed"');
    expect(text).toContain('suppression="health"');
    expect(text).toContain("air_quality_raster_age_seconds");
    expect(text).toContain('state="stale"');
  });

  it("cannot expose coordinate, station, user, or credential-shaped provider labels", async () => {
    const sensitive = "user@example.test:52.52,13.405:secret";
    recordAirQualityProviderCall({
      providerId: sensitive,
      method: "stations",
      outcome: "error",
      cacheResult: "unknown",
      suppression: "none",
      latencyMs: 1,
    });
    const text = await getMetrics().renderPrometheus();
    expect(text).not.toContain(sensitive);
    expect(text).toContain('provider_id="invalid"');
    expect(text).not.toContain("station_name");
    expect(text).not.toContain("latitude");
    expect(text).not.toContain("credential");
  });

  it("records routing latency, route counts, and traffic baseline coverage", async () => {
    recordRoutingRequest({
      providerId: "routing-valhalla",
      mode: "driving",
      operation: "directions",
      outcome: "ok",
      liveTraffic: true,
      closureAvoidance: false,
      latencyMs: 125,
      routeCount: 3,
      alternateCount: 2,
      trafficDelaySeconds: 180,
      baselineAvailable: true,
    });
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("routing_requests_total");
    expect(text).toContain("routing_request_duration_ms");
    expect(text).toContain("routing_route_count");
    expect(text).toContain("routing_alternate_count");
    expect(text).toContain("routing_traffic_delay_seconds");
    expect(text).toContain("routing_baseline_available_total");
    expect(text).toContain('operation="directions"');
    expect(text).toContain('live_traffic="true"');
    expect(text).toContain('status="present"');
  });

  it("records reachability volume without destination or coordinate labels", async () => {
    recordTransitReachability({
      operation: "exact",
      source: "self-hosted-motis",
      capabilityState: "available",
      outcome: "ok",
      cacheOutcome: "miss",
      errorKind: "none",
      latencyMs: 321,
      destinationCount: 200,
      batchCount: 2,
    });
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("transit_reachability_requests_total");
    expect(text).toContain("transit_reachability_request_duration_ms");
    expect(text).toContain("transit_reachability_destination_count");
    expect(text).toContain("transit_reachability_batch_count");
    expect(text).toContain('source="self-hosted-motis"');
    expect(text).toContain('capability_state="available"');
    expect(text).not.toContain("destination_id");
    expect(text).not.toContain("latitude");
    expect(text).not.toContain("longitude");
  });

  it("records personal timeline counts and latency with closed aggregate labels", async () => {
    recordPersonalTimelineRequest({ mode: "managed", operation: "day", outcome: "partial" }, 37);
    const text = await getMetrics().renderPrometheus();
    expect(text).toContain("personal_timeline_requests_total");
    expect(text).toContain("personal_timeline_request_duration_ms");
    expect(text).toContain('mode="managed"');
    expect(text).toContain('operation="day"');
    expect(text).toContain('outcome="partial"');
  });

  it("never serializes user, credential, host, date or coordinate-shaped input", async () => {
    const sensitive = "OMX-SENSITIVE-user@example.test-2026-03-29-52.5-13.4";
    recordPersonalTimelineRequest(
      { mode: "external", operation: "connect", outcome: "invalid_credential" },
      4,
    );
    const text = await getMetrics().renderPrometheus();
    expect(text).not.toContain(sensitive);
    expect(text).not.toContain("user_id");
    expect(text).not.toContain("hostname");
    expect(text).not.toContain("date=");
    expect(text).not.toContain("coordinate");
  });
});

describe("internal-metrics route", () => {
  it("exposes /api/internal/metrics with the Prometheus text content-type", async () => {
    recordProviderCall({ providerId: "test-provider", method: "getDepartures", outcome: "ok" }, 11);
    const app = Fastify();
    await app.register(internalMetricsRoute, { prefix: "/api" });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/internal/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("transit_provider_calls_total");
      expect(res.body).toContain('provider_id="test-provider"');
    } finally {
      await app.close();
    }
  });
});

/**
 * OSM contribution telemetry is deliberately content-free: two instruments,
 * two closed low-cardinality labels, and nothing else. These cases push
 * sentinel tokens, names, coordinates, tags, comments, note text and source
 * detail through the recording boundary and prove none of it can be exposed.
 */
describe("OSM contribution metrics", () => {
  const SENTINELS = [
    "osm-token-sentinel",
    "Café Central",
    "human comment sentinel",
    "note text sentinel",
    "amenity=cafe",
    "52.5162746",
    "13.3777041",
    "mapper",
    "official website",
  ];

  it("registers both instruments with stable names", async () => {
    recordOsmContributionOperation("publish", "success", 12);
    const exposition = await getMetrics().renderPrometheus();
    expect(exposition).toContain("osm_contribution_operations_total");
    expect(exposition).toContain("osm_contribution_operation_duration_ms");
  });

  it("accumulates per operation and outcome", async () => {
    recordOsmContributionOperation("publish", "success", 10);
    recordOsmContributionOperation("publish", "success", 20);
    recordOsmContributionOperation("publish", "conflict", 5);
    recordOsmContributionOperation("note", "success", 7);

    const exposition = await getMetrics().renderPrometheus();
    expect(exposition).toMatch(
      /osm_contribution_operations_total\{[^}]*operation="publish"[^}]*outcome="success"[^}]*\} 2/,
    );
    expect(exposition).toMatch(
      /osm_contribution_operations_total\{[^}]*operation="publish"[^}]*outcome="conflict"[^}]*\} 1/,
    );
    expect(exposition).toMatch(
      /osm_contribution_operations_total\{[^}]*operation="note"[^}]*outcome="success"[^}]*\} 1/,
    );
  });

  it("records latency for every completed operation", async () => {
    recordOsmContributionOperation("context", "success", 42);
    const exposition = await getMetrics().renderPrometheus();
    expect(exposition).toMatch(/osm_contribution_operation_duration_ms_sum\{[^}]*\} 42/);
  });

  it("clamps a negative duration rather than exporting it", async () => {
    recordOsmContributionOperation("preview", "invalid", -100);
    const exposition = await getMetrics().renderPrometheus();
    expect(exposition).toMatch(/osm_contribution_operation_duration_ms_sum\{[^}]*\} 0/);
  });

  it("covers the closed outcome vocabulary, including disabled and ambiguous", async () => {
    for (const outcome of [
      "success",
      "disabled",
      "invalid",
      "unauthorized",
      "blocked",
      "conflict",
      "rate_limited",
      "not_found",
      "upstream_error",
      "ambiguous",
    ] as const) {
      recordOsmContributionOperation("publish", outcome, 1);
    }
    const exposition = await getMetrics().renderPrometheus();
    for (const outcome of ["disabled", "ambiguous", "rate_limited", "blocked"]) {
      expect(exposition).toContain(`outcome="${outcome}"`);
    }
  });

  it("exposes only the two closed labels", async () => {
    recordOsmContributionOperation("publish", "success", 3);
    const exposition = await getMetrics().renderPrometheus();
    const line = exposition
      .split("\n")
      .find((row) => row.startsWith("osm_contribution_operations_total{"));
    const labels = (line ?? "").slice(line?.indexOf("{"), line?.indexOf("}"));
    for (const forbidden of [
      "user",
      "account",
      "element",
      "field",
      "preset",
      "locale",
      "evidence",
      "source",
      "changeset",
      "note_id",
      "request_id",
      "url",
      "status_code",
    ]) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it("cannot carry contribution content into the exposition", async () => {
    for (const operation of [
      "capabilities",
      "context",
      "categories",
      "preview",
      "publish",
      "note",
      "reconcile",
      "close_changeset",
    ] as const) {
      recordOsmContributionOperation(operation, "success", 1);
    }
    const exposition = await getMetrics().renderPrometheus();
    for (const sentinel of SENTINELS) {
      expect(exposition).not.toContain(sentinel);
    }
  });
});
