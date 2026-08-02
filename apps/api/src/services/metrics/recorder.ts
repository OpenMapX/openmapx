import type { MetricsRecorder } from "@openmapx/integration-framework";
import { recordProviderCall, recordRoutingRequest, recordTransitDecision } from "./index.js";

/**
 * Bridge between the integration-framework's structural `MetricsRecorder`
 * shape and the OTEL handle exposed by `./index.js`. The orchestrator
 * receives this through `IntegrationContext.metricsRecorder` and calls
 * `recordProviderCall(labels, latencyMs)` per provider invocation.
 *
 * The recorder lazy-initialises the meter provider on first use so a process
 * that never executes a provider call (CLI scripts, tests) never spins up
 * OTEL infrastructure.
 */
export function getMetricsRecorder(): MetricsRecorder {
  return {
    recordProviderCall(labels, latencyMs) {
      recordProviderCall(labels, latencyMs);
    },
    recordTransitDecision(labels, value) {
      recordTransitDecision(labels, value);
    },
    recordRoutingRequest(metrics) {
      recordRoutingRequest(metrics);
    },
  };
}
