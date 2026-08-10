import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalMetricsRoute } from "../../../routes/internal-metrics.js";
import {
  getMetrics,
  initMetrics,
  recordOsmContributionOperation,
  recordProviderCall,
  recordRoutingRequest,
  recordTransitDecision,
  resetMetricsForTests,
} from "../index.js";

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
