import type { DataSourceResult } from "@openmapx/core";

/**
 * Deduplicates results by rounding coordinates to 4 decimal places (~11m).
 * First-seen wins - pass results in priority order (Windy > Caltrans > TfL > OSM).
 */
export function deduplicateByCoordinates(results: DataSourceResult[]): DataSourceResult[] {
  const seen = new Set<string>();
  const deduped: DataSourceResult[] = [];

  for (const result of results) {
    const [lng, lat] = result.coordinates;
    const key = `${Math.round(lat * 10000)},${Math.round(lng * 10000)}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(result);
    }
  }

  return deduped;
}
