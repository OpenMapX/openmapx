import {
  getRoadConditionRoutingDecision,
  hasRoadRestrictionEvidence,
  type RoadConditionEvent,
  type RoadConditionRouteImpact,
  type TravelMode,
} from "@openmapx/core";

export interface RoadConditionRouteContext {
  evaluatedAt: number;
  travelAt: number;
  mode: TravelMode;
  sharedTrafficApplied: boolean;
  allowLegacyGeometry?: boolean;
  disallowedSources?: ReadonlySet<string>;
}

export function evidenceBoundCacheTtlSeconds(
  validUntil: string | null,
  nowMs = Date.now(),
): number {
  if (!validUntil) return 0;
  const deadline = Date.parse(validUntil);
  if (!Number.isFinite(deadline) || deadline <= nowMs) return 0;
  return Math.min(30, Math.floor((deadline - nowMs) / 1_000));
}

export function roadConditionImpactForRequest(
  closureImpact: RoadConditionRouteImpact | null,
  includeCurrentTraffic: boolean,
  additionalReasons: readonly string[] = [],
): RoadConditionRouteImpact | undefined {
  if (!includeCurrentTraffic && !closureImpact && additionalReasons.length === 0) return undefined;
  const base =
    closureImpact ??
    ({
      availability: "unsupported",
      evaluatedAt: new Date().toISOString(),
      validUntil: null,
      reasons: [],
    } satisfies RoadConditionRouteImpact);
  const reasons = new Set(base.reasons);
  if (includeCurrentTraffic) reasons.add("unverified_engine_application");
  for (const reason of additionalReasons) reasons.add(reason);
  return {
    ...base,
    availability:
      base.availability === "limited"
        ? "limited"
        : includeCurrentTraffic || additionalReasons.length > 0
          ? "unsupported"
          : base.availability,
    reasons: [...reasons],
  };
}

export interface RoadConditionRouteDecision {
  disposition: "legacy-geometry" | "shared-traffic" | "ignore";
  reasons: string[];
  validUntil: string | null;
}

/** Pure route-side interpretation of one event; implemented through its contract tests. */
export function assessRoadConditionForRoute(
  event: RoadConditionEvent,
  context: RoadConditionRouteContext,
): RoadConditionRouteDecision {
  // Restriction evidence outranks every other disposition, including the
  // legacy-geometry path, which would otherwise let a vehicle-conditioned
  // record steer a route without any routing evidence at all.
  if (hasRoadRestrictionEvidence(event)) {
    return { disposition: "ignore", reasons: ["vehicle_specific_restriction"], validUntil: null };
  }
  if (!event.routingEvidence) {
    if (event.binding || !context.allowLegacyGeometry) {
      return { disposition: "ignore", reasons: ["missing_routing_evidence"], validUntil: null };
    }
    return {
      disposition: "legacy-geometry",
      reasons: ["legacy_geometry_unverified"],
      validUntil: null,
    };
  }

  const eligibility = getRoadConditionRoutingDecision(event, {
    evaluatedAt: context.evaluatedAt,
    travelAt: context.travelAt,
    disallowedSources: context.disallowedSources,
    sharedTraffic: true,
  });
  if (!eligibility.eligible) {
    return {
      disposition: "ignore",
      reasons: eligibility.reasons,
      validUntil: eligibility.validUntil,
    };
  }

  const reasons: string[] = [];
  if (context.mode !== "driving" && context.mode !== "motorcycle") {
    reasons.push("unsupported_mode");
  }
  if (context.travelAt !== context.evaluatedAt) {
    reasons.push("unsupported_future_shared_traffic");
  }
  if (!context.sharedTrafficApplied) {
    reasons.push("unverified_engine_application");
  }
  return {
    disposition: reasons.length === 0 ? "shared-traffic" : "ignore",
    reasons,
    validUntil: eligibility.validUntil,
  };
}
