import { getRoadConditionRoutingDecision, type TrafficApplicationReceipt } from "@openmapx/core";
import type { BoundCondition, EdgeOverride } from "./conditions-to-edges.js";
import type { WayEdge } from "./ways-to-edges.js";

export type { TrafficApplicationReceipt, TrafficApplicationSnapshot } from "@openmapx/core";

export function buildTrafficReceipts(options: {
  conditions: BoundCondition[];
  overrides: Map<string, EdgeOverride & { edge: WayEdge }>;
  appliedObservationIds: string[];
  graphGeneration: string;
  policyRevision: string;
  validUntil: string;
  evaluatedAt?: number;
}): TrafficApplicationReceipt[] {
  const now = options.evaluatedAt ?? Date.now();
  if (
    !options.graphGeneration ||
    !options.policyRevision ||
    !(Date.parse(options.validUntil) > now)
  )
    return [];
  const applied = new Set(options.appliedObservationIds);
  return options.conditions.flatMap((c) => {
    const e = c.routingEvidence;
    const decision = getRoadConditionRoutingDecision(
      {
        source: c.source ?? "",
        routingEvidence: e,
        originKind: c.originKind === "feed" ? "feed" : "crowd",
        routingEligible: c.routingEligible,
      },
      { evaluatedAt: now },
    );
    if (!e || !applied.has(c.id) || !decision.eligible || !decision.validUntil) return [];
    const edges = [...options.overrides.entries()].filter(([, o]) =>
      (o.contributorIds ?? [o.observationId]).includes(c.id),
    );
    if (!edges.length) return [];
    return [
      {
        observationId: c.id,
        observationRevision: e.observation_revision,
        sourceId: c.source ?? e.source_id,
        graphGeneration: options.graphGeneration,
        sourceGraphGeneration: e.graph_generation,
        policyRevision: options.policyRevision,
        validUntil: new Date(
          Math.min(Date.parse(options.validUntil), Date.parse(decision.validUntil)),
        ).toISOString(),
        complete: true as const,
        effect:
          c.speedLimitKph != null && c.roadState !== "closed" && c.type !== "road_closure"
            ? ("speed_cap" as const)
            : ("closure" as const),
        intendedSpans: e.segments,
        edgeKeys: edges.map(([key]) => key).sort(),
        sourceLicense: e.source_license,
        attribution: e.attribution,
      },
    ];
  });
}
