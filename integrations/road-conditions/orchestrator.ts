import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { dedupeRoadConditionEvents } from "./dedupe.js";
import type {
  RoadConditionEvent,
  RoadConditionsProvider,
  RoadConditionsQuery,
  RoadFlowQuery,
  RoadFlowSegment,
} from "./types.js";

/** A flow segment stamped with the producing integration id, mirroring
 * `RoadConditionEvent.provider` — not part of the `RoadFlowSegment` contract
 * type itself (segments have no such field), so it is added here at the
 * aggregation boundary rather than on the wire type. */
export type RoadFlowSegmentWithProvider = RoadFlowSegment & { provider: string };

/** All road-conditions providers registered across enabled integrations. */
export function collectProviders(ctx: IntegrationContext): RoadConditionsProvider[] {
  return ctx
    .getIntegrationsByDomain("road-conditions")
    .flatMap((i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[]);
}

function coversBbox(coverage: RoadConditionsProvider["coverage"], bbox: BBox): boolean {
  if (!coverage || "all" in coverage) return true;
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = coverage.bbox;
  return !(e < cw || w > ce || n < cs || s > cn);
}

/**
 * Fans the query out to every enabled provider in parallel, tolerating
 * individual failures (`Promise.allSettled`), stamps each event with the
 * producing integration id, drops events whose `source` the operator's data-use
 * policy disallows, then dedupes across providers. This is a MERGE (the union of
 * all providers' events), not a fallback chain.
 */
export async function aggregateRoadConditions(
  ctx: IntegrationContext,
  bbox: BBox,
  opts?: RoadConditionsQuery,
): Promise<RoadConditionEvent[]> {
  const providers = collectProviders(ctx).filter((p) => coversBbox(p.coverage, bbox));
  const settled = await Promise.allSettled(providers.map((p) => p.getEvents(bbox, opts)));

  const merged: RoadConditionEvent[] = [];
  settled.forEach((res, i) => {
    const providerId = providers[i]!.id;
    if (res.status === "fulfilled") {
      for (const e of res.value) merged.push(e.provider ? e : { ...e, provider: providerId });
    } else {
      ctx.log.warn(`[road-conditions] provider ${providerId} failed`, res.reason);
    }
  });

  const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
  const allowed = disallowed.size > 0 ? merged.filter((e) => !disallowed.has(e.source)) : merged;

  return dedupeRoadConditionEvents(allowed);
}

/**
 * Fans the flow query out to every enabled provider that implements the
 * optional `getFlow` capability, tolerating individual failures
 * (`Promise.allSettled`), and stamps each segment with the producing
 * integration id. Unlike {@link aggregateRoadConditions} this is a plain
 * merge with no dedup step — segments are already unique by `segment_id`
 * (the producing provider owns that uniqueness), so there is nothing to
 * collapse across providers.
 */
export async function aggregateRoadFlow(
  ctx: IntegrationContext,
  bbox: BBox,
  opts?: RoadFlowQuery,
): Promise<RoadFlowSegmentWithProvider[]> {
  const providers = collectProviders(ctx).filter(
    (p) => coversBbox(p.coverage, bbox) && typeof p.getFlow === "function",
  );
  const settled = await Promise.allSettled(providers.map((p) => p.getFlow!(bbox, opts)));

  const merged: RoadFlowSegmentWithProvider[] = [];
  settled.forEach((res, i) => {
    const providerId = providers[i]!.id;
    if (res.status === "fulfilled") {
      for (const s of res.value) merged.push({ ...s, provider: providerId });
    } else {
      ctx.log.warn(`[road-conditions] provider ${providerId} failed getFlow`, res.reason);
    }
  });

  const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
  return disallowed.size > 0
    ? merged.filter((s) => !s.source || !disallowed.has(s.source))
    : merged;
}
