import { closesRoadForCars, type TrafficApplicationReceipt } from "@openmapx/core";
import {
  type BoundCondition,
  conditionRoutingDecision,
  type EdgeOverride,
} from "./conditions-to-edges.js";
import type { WayEdge } from "./ways-to-edges.js";

export type { TrafficApplicationReceipt, TrafficApplicationSnapshot } from "@openmapx/core";

/**
 * One receipt per applied effect: `observationId` is the condition id
 * (`<recordId>#<effectId>`) and `observationRevision` the record revision the
 * binding resolved, so a router can match it to exactly one effect of exactly
 * one situation revision.
 */
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
    const decision = conditionRoutingDecision(c, { evaluatedAt: now });
    if (!applied.has(c.id) || !decision.eligible || !decision.validUntil) return [];
    const edges = [...options.overrides.entries()].filter(([, o]) =>
      (o.contributorIds ?? [o.observationId]).includes(c.id),
    );
    if (!edges.length) return [];
    return [
      {
        observationId: c.id,
        observationRevision: String(e.record_revision),
        sourceId: c.source,
        graphGeneration: options.graphGeneration,
        sourceGraphGeneration: e.graph_generation,
        policyRevision: options.policyRevision,
        validUntil: new Date(
          Math.min(Date.parse(options.validUntil), Date.parse(decision.validUntil)),
        ).toISOString(),
        complete: true as const,
        effect: closesRoadForCars(c.effect) ? ("closure" as const) : ("speed_cap" as const),
        intendedSpans: e.segments,
        edgeKeys: edges.map(([key]) => key).sort(),
        sourceLicense: e.source_license,
        attribution: e.attribution,
      },
    ];
  });
}
