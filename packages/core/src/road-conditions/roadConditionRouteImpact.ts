import type { DirectionsResult, RoadConditionRouteImpact } from "../types/routing";

/** Return an assessment that cannot claim currency after its evidence lease ends. */
export function expireRoadConditionRouteImpact(
  impact: RoadConditionRouteImpact | null | undefined,
  nowMs = Date.now(),
): RoadConditionRouteImpact | null | undefined {
  if (impact?.availability !== "current") return impact;
  const deadline = impact.validUntil ? Date.parse(impact.validUntil) : NaN;
  if (Number.isFinite(deadline) && deadline > nowMs) return impact;
  return {
    ...impact,
    availability: "expired",
    reasons: [...new Set([...impact.reasons, "evidence_expired"])],
  };
}

export function expireDirectionsRoadConditionImpact<T extends DirectionsResult>(
  result: T | undefined,
  nowMs = Date.now(),
): T | undefined {
  if (!result?.roadConditionImpact) return result;
  const impact = expireRoadConditionRouteImpact(result.roadConditionImpact, nowMs);
  return impact === result.roadConditionImpact
    ? result
    : { ...result, roadConditionImpact: impact };
}

/** What a route card tells the traveller about road conditions, when anything. */
export type RoadConditionRouteNotice = "notApplied" | "outdated" | "checkFailed";

/**
 * Reasons that describe the request or the deployment rather than any reported
 * road condition: no provider configured, nothing currently reported, or live
 * traffic whose application the engine cannot prove. On their own they leave
 * nothing a traveller could act on.
 */
const NOTHING_REPORTED_REASONS = new Set([
  "no_road_condition_provider",
  "missing_current_evidence",
  "unverified_engine_application",
  "unsupported_future_shared_traffic",
  "ev_matrix_unprotected",
]);

/**
 * The road-condition notice worth showing on a route, or `null` when there is
 * nothing to say. A route is only flagged when reported conditions nearby may
 * not be reflected in it, when its condition data has gone stale, or when a
 * provider failed to answer — not merely because no conditions exist.
 */
export function roadConditionRouteNotice(
  impact: RoadConditionRouteImpact | null | undefined,
): RoadConditionRouteNotice | null {
  if (!impact) return null;
  switch (impact.availability) {
    case "current":
      return null;
    case "expired":
      return "outdated";
    case "limited":
      return "notApplied";
    case "unavailable":
    case "unsupported":
      if (impact.reasons.includes("road_condition_provider_unavailable")) return "checkFailed";
      if (impact.availability === "unavailable") return null;
      return impact.reasons.every((reason) => NOTHING_REPORTED_REASONS.has(reason))
        ? null
        : "notApplied";
  }
}
