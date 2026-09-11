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
