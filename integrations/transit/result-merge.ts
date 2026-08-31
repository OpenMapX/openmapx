import type { Attribution } from "@openmapx/mobility-core/attribution";
import { type Freshness, freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";

export interface AttributionOrderer {
  dedupAndOrder(attributions: Attribution[]): Attribution[];
}

export function emptyResult<T>(
  data: T,
  options?: { hasRealtimeData?: boolean },
): MobilityResult<T> {
  return { data, attributions: [], freshness: freshnessNow(options) };
}

export function mergeAttributions(
  index: AttributionOrderer | undefined,
  ...lists: Attribution[][]
): Attribution[] {
  if (index) return index.dedupAndOrder(lists.flat());

  const seen = new Set<string>();
  const merged: Attribution[] = [];
  for (const list of lists) {
    for (const attribution of list) {
      if (seen.has(attribution.sourceId)) continue;
      seen.add(attribution.sourceId);
      merged.push(attribution);
    }
  }
  return merged;
}

export function mergeFreshness(...values: Freshness[]): Freshness {
  if (values.length === 0) return freshnessNow();

  let fetchedAt = values[0].fetchedAt;
  let hasRealtimeData = false;
  let isStale = false;
  let dataAsOf: string | undefined;
  for (const value of values) {
    if (value.fetchedAt < fetchedAt) fetchedAt = value.fetchedAt;
    if (value.hasRealtimeData) hasRealtimeData = true;
    if (value.isStale) isStale = true;
    if (value.dataAsOf && (!dataAsOf || value.dataAsOf < dataAsOf)) dataAsOf = value.dataAsOf;
  }
  return { fetchedAt, hasRealtimeData, isStale, ...(dataAsOf ? { dataAsOf } : {}) };
}
