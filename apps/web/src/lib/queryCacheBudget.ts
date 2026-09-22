import { isOfflineQueryRetentionEnabled } from "@openmapx/core";
import type { Query, QueryClient } from "@tanstack/react-query";
import { isRecentMapDataQueryKey } from "./recentMapDataCache";

const HIGH_CARDINALITY_ROOTS = new Set([
  "airport-nearest",
  "airport-search",
  "autocomplete",
  "brand-suggest",
  "category-search",
  "country-from-coords",
  "data-source-detail",
  "data-source-map-context",
  "data-source-search",
  "ds-match-detail",
  "ds-match-search",
  "filter-search",
  "geocode",
  "isochrone",
  "neighborhoods",
  "nlp-search",
  "place",
  "placePhotos",
  "preset-suggest",
  "reverse-geocode",
  "search-suggestions",
  "text-search",
  "transit-stops",
  "transit-stops-nearby",
]);

export const DEFAULT_HIGH_CARDINALITY_CACHE_BUDGET = Object.freeze({
  maxInactiveEntries: 200,
  maxEstimatedBytes: 32 * 1024 * 1024,
});

export interface QueryCacheMetrics {
  activeCount: number;
  inactiveCount: number;
  estimatedBytes: number;
}

export interface QueryCacheBudget {
  maxInactiveEntries: number;
  maxEstimatedBytes: number;
}

interface MeasuredQuery {
  query: Query;
  active: boolean;
  estimatedBytes: number;
}

function isHighCardinalityQuery(query: Query): boolean {
  const root = query.queryKey[0];
  if (typeof root !== "string" || !HIGH_CARDINALITY_ROOTS.has(root)) return false;
  // Queries the user asked to keep for offline use are governed by the
  // persister's maxAge, not by the in-memory budget.
  return !(isOfflineQueryRetentionEnabled() && isRecentMapDataQueryKey(query.queryKey));
}

/**
 * Bounded structural estimate that avoids serializing a large GeoJSON payload
 * into a second giant string. It intentionally favors a conservative estimate
 * over exact JavaScript heap accounting.
 */
function estimateBytes(value: unknown, stopAfter: number): { bytes: number; exact: boolean } {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;

  while (stack.length > 0 && bytes <= stopAfter) {
    const current = stack.pop();
    if (current === null || current === undefined) {
      bytes += 4;
    } else if (typeof current === "string") {
      bytes += current.length * 2;
    } else if (typeof current === "number" || typeof current === "bigint") {
      bytes += 8;
    } else if (typeof current === "boolean") {
      bytes += 4;
    } else if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      if (ArrayBuffer.isView(current)) {
        bytes += current.byteLength;
      } else if (current instanceof ArrayBuffer) {
        bytes += current.byteLength;
      } else if (Array.isArray(current)) {
        bytes += current.length * 8;
        for (const nested of current) stack.push(nested);
      } else {
        for (const key in current) {
          if (!Object.hasOwn(current, key)) continue;
          bytes += key.length * 2 + 8;
          stack.push((current as Record<string, unknown>)[key]);
        }
      }
    }
  }

  return { bytes, exact: stack.length === 0 };
}

// Query data is immutable; weak keys let removed queries and payloads be collected.
const measurements = new WeakMap<Query, { data: unknown; bytes: number; exact: boolean }>();

function measureQuery(query: Query, stopAfter: number): number {
  const previous = measurements.get(query);
  if (
    previous &&
    Object.is(previous.data, query.state.data) &&
    (previous.exact || previous.bytes > stopAfter)
  )
    return previous.bytes;
  const result = estimateBytes(query.state.data, stopAfter);
  measurements.set(query, { data: query.state.data, ...result });
  return result.bytes;
}

function measure(client: QueryClient, stopAfter: number): MeasuredQuery[] {
  return client
    .getQueryCache()
    .getAll()
    .filter(isHighCardinalityQuery)
    .map((query) => ({
      query,
      active: query.getObserversCount() > 0,
      estimatedBytes: measureQuery(query, stopAfter),
    }));
}

function metrics(measured: MeasuredQuery[]): QueryCacheMetrics {
  return measured.reduce<QueryCacheMetrics>(
    (result, entry) => {
      if (entry.active) result.activeCount += 1;
      else result.inactiveCount += 1;
      result.estimatedBytes += entry.estimatedBytes;
      return result;
    },
    { activeCount: 0, inactiveCount: 0, estimatedBytes: 0 },
  );
}

export function collectHighCardinalityQueryCacheMetrics(client: QueryClient): QueryCacheMetrics {
  return metrics(measure(client, Number.POSITIVE_INFINITY));
}

export function pruneHighCardinalityQueryCache(
  client: QueryClient,
  budget: QueryCacheBudget = DEFAULT_HIGH_CARDINALITY_CACHE_BUDGET,
): { before: QueryCacheMetrics; after: QueryCacheMetrics; removed: number } {
  const measured = measure(client, budget.maxEstimatedBytes + 1);
  const before = metrics(measured);
  let inactiveCount = before.inactiveCount;
  let estimatedBytes = before.estimatedBytes;
  let removed = 0;

  const inactiveOldestFirst = measured
    .filter((entry) => !entry.active)
    .sort(
      (left, right) =>
        left.query.state.dataUpdatedAt - right.query.state.dataUpdatedAt ||
        left.query.queryHash.localeCompare(right.query.queryHash),
    );

  for (const entry of inactiveOldestFirst) {
    if (inactiveCount <= budget.maxInactiveEntries && estimatedBytes <= budget.maxEstimatedBytes) {
      break;
    }
    client.removeQueries({ queryKey: entry.query.queryKey, exact: true });
    inactiveCount -= 1;
    estimatedBytes -= entry.estimatedBytes;
    removed += 1;
  }

  return {
    before,
    after: { activeCount: before.activeCount, inactiveCount, estimatedBytes },
    removed,
  };
}

/** Install a debounced check for data and observer membership changes. */
export function installHighCardinalityQueryCacheBudget(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      pruneHighCardinalityQueryCache(client);
    }, 1_000);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!isHighCardinalityQuery(event.query)) return;
    if (
      event.type === "added" ||
      event.type === "observerAdded" ||
      event.type === "observerRemoved" ||
      (event.type === "updated" &&
        (event.action.type === "success" || event.action.type === "setState"))
    )
      schedule();
    // Removal only lowers the budget; scheduling it would feed back into pruning.
  });
  schedule();

  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}
