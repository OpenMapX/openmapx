/**
 * Coordinate-based deduplication for shared mobility results.
 * Two stations within ~11m are considered duplicates.
 */

import type { SharedMobilityStation } from "./types.js";

/** Round to 4 decimal places (~11m precision). */
function coordKey(lng: number, lat: number): string {
  return `${lng.toFixed(4)},${lat.toFixed(4)}`;
}

/**
 * Dedup stations by coordinates. First-seen wins (priority order in input).
 */
export function dedupStations(stations: SharedMobilityStation[]): SharedMobilityStation[] {
  const seen = new Set<string>();
  const result: SharedMobilityStation[] = [];

  for (const s of stations) {
    const key = coordKey(s.coordinates[0], s.coordinates[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }

  return result;
}
