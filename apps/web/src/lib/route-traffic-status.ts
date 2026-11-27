import type { RoadConditionRouteImpact, Route } from "@openmapx/core";

/** What the capabilities and integration metadata say about each routing integration. */
export type RoutingEngineLabels = Readonly<
  Record<string, { readonly name: string; readonly trafficProof: boolean }>
>;

export interface RouteTrafficStatusValue {
  application: "verified" | "expired" | "limited" | "unavailable" | "unverified";
  /** The routing integration that produced the route; null when the answer names none. */
  source: { integrationId: string; name: string; hosted: boolean } | null;
  deadline: number | null;
}

/** Consumer guard, not an independent check of the engine's active graph.
 * The server assessment verifies graph/write/boot identity for this response.
 * Neither that assessment nor its proof establishes congestion's effect on ETA.
 */
export function routeTrafficStatus(
  route: Route,
  impact: RoadConditionRouteImpact | undefined,
  provider: string | undefined,
  engines: RoutingEngineLabels,
  nowMs: number,
): RouteTrafficStatusValue | null {
  if (route.mode !== "driving" && route.mode !== "motorcycle") return null;
  // A hosted engine answers from a graph this server's traffic writer never touched.
  const hosted = route.sourceIds?.includes("stadia-maps") === true;
  const engine = provider && Object.hasOwn(engines, provider) ? engines[provider] : undefined;
  const source = provider
    ? { integrationId: provider, name: engine?.name ?? provider, hosted }
    : null;
  const result: RouteTrafficStatusValue = { application: "unverified", source, deadline: null };
  if (impact?.availability === "expired") return { ...result, application: "expired" };
  if (impact?.availability === "limited") return { ...result, application: "limited" };
  if (impact?.availability === "unavailable" || impact?.availability === "unsupported")
    return { ...result, application: "unavailable" };
  const p = route.trafficProof;
  if (engine?.trafficProof !== true || hosted || !p || impact?.availability !== "current")
    return result;
  if (
    p.schemaVersion !== 1 ||
    (p.endpoint !== "route" && p.endpoint !== "optimized_route") ||
    p.costing !== (route.mode === "driving" ? "auto" : "motorcycle") ||
    ![p.requestId, p.writeId, p.graphGeneration, p.engineBootId, p.evaluatedAt, p.validUntil].every(
      (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256,
    )
  )
    return result;
  const evaluatedAt = Date.parse(p.evaluatedAt);
  const proofDeadline = Date.parse(p.validUntil);
  const assessmentTime = Date.parse(impact.evaluatedAt);
  const assessmentDeadline = impact.validUntil ? Date.parse(impact.validUntil) : NaN;
  if (
    ![nowMs, evaluatedAt, proofDeadline, assessmentTime, assessmentDeadline].every(Number.isFinite)
  )
    return result;
  if (
    evaluatedAt > nowMs ||
    assessmentTime > nowMs ||
    assessmentTime < evaluatedAt ||
    impact.reasons.length > 0
  )
    return result;
  if (proofDeadline <= nowMs || assessmentDeadline <= nowMs)
    return { ...result, application: "expired" };
  if (assessmentDeadline > proofDeadline) return result;
  return {
    application: "verified",
    source,
    deadline: Math.min(proofDeadline, assessmentDeadline),
  };
}
