import type { Attribution } from "./attribution.js";
import type { Freshness } from "./freshness.js";

/**
 * Trace of a single provider call that contributed to a result.
 * Surfaced for debugging, observability, and per-leg attribution.
 */
export interface ProviderTrace {
  /** Provider id, e.g. "transit-motis-local", "bike-sharing-gbfs". */
  providerId: string;
  /** Roundtrip latency in milliseconds. */
  latencyMs: number;
  /** Outcome of the call. */
  status: "ok" | "empty" | "error" | "timeout" | "skipped";
  /** Optional short reason, especially for non-ok statuses. */
  reason?: string;
}

/**
 * Canonical envelope every provider returns. `data` is the typed payload;
 * `attributions`, `freshness`, and (optionally) `trace` travel alongside.
 */
export interface MobilityResult<T> {
  data: T;
  attributions: Attribution[];
  freshness: Freshness;
  /** Per-provider trace, populated by the orchestrator when present. */
  trace?: ProviderTrace[];
}

/**
 * Convenience builder for the common case where one provider produces a result
 * with one or more attributions.
 *
 * Example:
 *   const stops = await fetchStops();
 *   return withAttribution(stops, [{ sourceId: "delfi-de", name: "DELFI" }], {
 *     fetchedAt: new Date().toISOString(),
 *     hasRealtimeData: false,
 *     isStale: false,
 *   });
 */
export function withAttribution<T>(
  data: T,
  attributions: Attribution[],
  freshness: Freshness,
): MobilityResult<T> {
  return { data, attributions, freshness };
}
