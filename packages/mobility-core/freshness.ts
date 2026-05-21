/**
 * Freshness envelope attached to every MobilityResult.
 * Lets the orchestrator and UI reason about realtime quality without
 * inspecting domain-specific fields.
 */
export interface Freshness {
  /** ISO 8601 timestamp the upstream said the data is valid as of. */
  dataAsOf?: string;
  /** ISO 8601 timestamp we ingested the data. Always set. */
  fetchedAt: string;
  /** True when this entity contains realtime data (e.g. delays, vehicle positions). */
  hasRealtimeData: boolean;
  /** True when realtime data is stale beyond a per-class threshold. */
  isStale: boolean;
}
