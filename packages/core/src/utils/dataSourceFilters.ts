import type { DataSourceFilterDef, DataSourceResult } from "../types/dataSource";

/**
 * Separate filter values into server-side and client-side groups based on
 * the filter definitions provided by the data-source provider.
 *
 * Filters marked `clientSide: true` in their definition, plus the dynamic
 * "operator" filter (which is always derived from results), go into
 * `clientFilters`. Everything else goes into `serverFilters`.
 */
export function splitFilters(
  filters: Record<string, unknown>,
  filterDefs: DataSourceFilterDef[],
): { serverFilters: Record<string, unknown>; clientFilters: Record<string, unknown> } {
  const clientIds = new Set<string>(["operator"]);
  for (const def of filterDefs) {
    if (def.clientSide) clientIds.add(def.id);
  }

  const serverFilters: Record<string, unknown> = {};
  const clientFilters: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (clientIds.has(key)) {
      clientFilters[key] = value;
    } else {
      serverFilters[key] = value;
    }
  }

  return { serverFilters, clientFilters };
}

/**
 * Apply client-side filters to data-source results.
 *
 * Handles the well-known client-side filters:
 * - `speed` — matches against `result.variant`
 * - `operator` — matches against `result.operator`
 * - `source` — matches against `result.source`
 * - `available_now` — when `true`, keeps only results with `availability.available > 0`
 * - opening hours — when set to `"open_now"`, keeps only `variant === "open"`
 */
export function applyClientSideFilters(
  results: DataSourceResult[],
  filters: Record<string, unknown>,
  openingHoursFilter?: string | null,
): DataSourceResult[] {
  let out = results;

  const speedFilter = filters.speed;
  if (speedFilter) {
    const speedValues = Array.isArray(speedFilter)
      ? (speedFilter as string[])
      : [String(speedFilter)];
    if (speedValues.length > 0) {
      const speedSet = new Set(speedValues);
      out = out.filter((r) => speedSet.has(r.variant));
    }
  }

  const operatorFilter = filters.operator;
  if (operatorFilter) {
    const operatorValues = Array.isArray(operatorFilter)
      ? (operatorFilter as string[])
      : [String(operatorFilter)];
    if (operatorValues.length > 0) {
      const operatorSet = new Set(operatorValues);
      out = out.filter((r) => r.operator && operatorSet.has(r.operator));
    }
  }

  const sourceFilter = filters.source;
  if (sourceFilter) {
    const sourceValues = Array.isArray(sourceFilter)
      ? (sourceFilter as string[])
      : [String(sourceFilter)];
    if (sourceValues.length > 0) {
      const sourceSet = new Set(sourceValues);
      out = out.filter((r) => sourceSet.has(r.source));
    }
  }

  if (filters.available_now === true) {
    out = out.filter((r) => (r.availability?.available ?? 0) > 0);
  }

  if (openingHoursFilter === "open_now") {
    out = out.filter((r) => r.variant === "open");
  }

  return out;
}
