import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { Departure } from "@openmapx/mobility-core/transit";

export interface TransitDataEvidence {
  /** Per-service evidence, never merely provider configuration. */
  realtime?: boolean;
  freshness?: Freshness;
  source?: string;
  queryFailed?: boolean;
}

/**
 * Trip updates: GTFS recommends source observations no more than 90 seconds old.
 * Staleness is judged by how far behind the source was when its data was
 * fetched, not by how long the board has been on screen since: our own caches
 * and refresh interval age every board, and a failed refresh is reported
 * separately. `ageSeconds` is the age of what is shown now.
 */
export function getTransitDataStatus(evidence: TransitDataEvidence, now: number) {
  const timing =
    evidence.realtime === true ? "realtime" : evidence.realtime === false ? "scheduled" : "unknown";
  const stamp = evidence.freshness?.dataAsOf ? Date.parse(evidence.freshness.dataAsOf) : NaN;
  const age = now - stamp;
  const ageSeconds =
    evidence.realtime === true &&
    evidence.freshness?.hasRealtimeData &&
    Number.isFinite(age) &&
    age >= 0
      ? Math.floor(age / 1000)
      : null;
  const fetched = evidence.freshness ? Date.parse(evidence.freshness.fetchedAt) : NaN;
  const lagAtFetch = Number.isFinite(fetched) ? Math.max(0, fetched - stamp) : age;
  const freshness = evidence.queryFailed
    ? "unknown"
    : evidence.freshness?.isStale
      ? "stale"
      : ageSeconds === null
        ? "unknown"
        : lagAtFetch <= 90_000
          ? "fresh"
          : "stale";
  const source = ["ms", "transit-motis-local"].includes(evidence.source ?? "")
    ? "local"
    : ["mo", "transit-motis", "entur"].includes(evidence.source ?? "")
      ? "hosted"
      : "unknown";
  return {
    timing,
    freshness,
    source,
    ageSeconds,
    partial: evidence.freshness?.isPartial === true,
    failed: evidence.queryFailed === true,
  } as const;
}

export function departureRealtimeEvidence(departure: Departure): boolean | undefined {
  const completeness = departure.provenance?.realtimeCompleteness;
  if (completeness === "merged" || completeness === "changed") return true;
  // Linked results can contain a prediction from another source without field-level provenance.
  if (completeness === "none" && !departure.expectedAt && departure.delaySeconds == null)
    return false;
  return undefined;
}
