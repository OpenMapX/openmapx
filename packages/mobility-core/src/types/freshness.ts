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
  /** True when contributing source queries failed or the source declared incomplete coverage. */
  isPartial?: boolean;
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

/**
 * Read an upstream "realtime data updated at" stamp, given as Unix seconds or an
 * ISO timestamp, into `Freshness.dataAsOf` form. Missing, unparseable and
 * future stamps give `undefined`: an age the source did not state stays unknown
 * instead of being guessed.
 */
export function upstreamDataAsOf(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms) || ms > Date.now()) return undefined;
  return new Date(ms).toISOString();
}

/**
 * The age of a set of realtime records stamped one by one: the oldest stamp,
 * and only when every record has one, since one unstated age makes the set's
 * age unknown.
 */
export function oldestDataAsOf(stamps: readonly (string | undefined)[]): string | undefined {
  if (stamps.length === 0 || stamps.some((stamp) => stamp === undefined)) return undefined;
  return (stamps as string[]).reduce((oldest, stamp) =>
    Date.parse(stamp) < Date.parse(oldest) ? stamp : oldest,
  );
}
