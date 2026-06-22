import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { dedupeRoadConditionEvents } from "./dedupe.js";
import type { RoadConditionEvent, RoadConditionsProvider, RoadConditionsQuery } from "./types.js";

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
