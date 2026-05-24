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

/**
 * Convenience factory: builds a `Freshness` with `fetchedAt = now()` and the
 * requested realtime / staleness flags. `isStale` defaults to false; callers
 * pass true when the underlying static table has never been ingested (cold
 * start) or when a max-age check on upstream realtime data tripped.
 */
export function freshnessNow(opts?: { hasRealtimeData?: boolean; isStale?: boolean }): Freshness {
  return {
    fetchedAt: new Date().toISOString(),
    hasRealtimeData: opts?.hasRealtimeData ?? false,
    isStale: opts?.isStale ?? false,
  };
}
