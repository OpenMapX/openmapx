import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalMetricsRoute } from "../../../routes/internal-metrics.js";
import {
  getMetrics,
  initMetrics,
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
