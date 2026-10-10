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
  let isPartial = false;
  for (const value of values) {
    if (Date.parse(value.fetchedAt) < Date.parse(fetchedAt)) fetchedAt = value.fetchedAt;
    if (value.hasRealtimeData) hasRealtimeData = true;
    if (value.isStale) isStale = true;
    if (value.isPartial) isPartial = true;
  }
  // Static stop-search metadata is not the age of realtime predictions.
  // Every realtime contributor must have a known age before claiming a combined one.
  const realtime = values.filter((value) => value.hasRealtimeData);
  const relevant = realtime.length ? realtime : values;
  const now = Date.now();
  const dates = relevant
    .map((value) => value.dataAsOf)
    .filter(
      (value): value is string =>
        typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now,
    );
  const dataAsOf =
    dates.length === relevant.length
      ? dates.reduce((oldest, value) => (Date.parse(value) < Date.parse(oldest) ? value : oldest))
      : undefined;
  return {
    fetchedAt,
    hasRealtimeData,
    isStale,
    ...(isPartial ? { isPartial: true } : {}),
    ...(dataAsOf ? { dataAsOf } : {}),
  };
}
