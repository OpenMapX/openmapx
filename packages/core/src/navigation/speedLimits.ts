import type { MatchResult } from "@integrations/routing/types";

/**
 * Posted speed limit (km/h) for each matched trace point of a map-match window,
 * aligned 1:1 to `match.points` (one per input trace point). Used for engines
 * that don't return per-segment limits on the route itself (Valhalla): the trace
 * sent to the matcher is a slice of `route.geometry`, so the caller can offset
 * these into a route-geometry-indexed array and look up the limit for the
 * segment the user is on — no per-fix map-match poll.
 *
 * A point yields `null` when it didn't match an edge, the edge carries no limit,
 * or the limit is non-positive (the engine's "unknown" sentinel).
 */
export function matchSpeedLimitsByPoint(match: MatchResult): (number | null)[] {
  return (match.points ?? []).map((point) => {
    if (point.edgeIndex === undefined) return null;
    const limit = match.edges?.[point.edgeIndex]?.speedLimit;
    return typeof limit === "number" && limit > 0 ? limit : null;
  });
}

/**
 * The first speed limit (km/h) worth showing from a precedence list — typically
 * the route's per-segment value, then a map-match value, then the per-step
 * fallback. Null, undefined and non-positive candidates are treated as unknown
 * and skipped; returns null when none qualify.
 */
export function pickSpeedLimit(...candidates: (number | null | undefined)[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && c > 0) return c;
  }
  return null;
}
