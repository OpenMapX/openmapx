/**
 * Coordinate-based deduplication for shared mobility results.
 * Two stations within ~11m are considered duplicates (primary check).
 * A secondary fuzzy check catches near-misses: within 50m + name similarity > 0.6.
 */

import { diceSimilarity, haversineMeters } from "@openmapx/core";
import type { SharedMobilityStation } from "./types.js";

/** Round to 4 decimal places (~11m precision). */
function coordKey(lng: number, lat: number): string {
  return `${lng.toFixed(4)},${lat.toFixed(4)}`;
}

/**
 * Dedup stations by coordinates, with a secondary fuzzy name+distance check.
 * First-seen wins (priority order in input).
 */
export function dedupStations(stations: SharedMobilityStation[]): SharedMobilityStation[] {
  const seen = new Set<string>();
  const result: SharedMobilityStation[] = [];

  for (const s of stations) {
    const key = coordKey(s.coordinates[0], s.coordinates[1]);
    if (seen.has(key)) continue;

    const isDuplicate = result.some((existing) => {
      const dist = haversineMeters(
        s.coordinates[1],
        s.coordinates[0],
        existing.coordinates[1],
        existing.coordinates[0],
      );
      if (dist > 50) return false;
      const nameA = s.name.toLowerCase().trim();
      const nameB = existing.name.toLowerCase().trim();
      return diceSimilarity(nameA, nameB) > 0.6;
    });

    if (isDuplicate) continue;
    seen.add(key);
    result.push(s);
  }

  return result;
}
