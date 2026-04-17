/**
 * Coordinate-based deduplication for shared mobility results.
 * Two stations within ~11m are considered duplicates (primary check).
 * A secondary fuzzy check catches near-misses: within 50m + name similarity > 0.6.
 */

import { diceSimilarity, haversineMeters } from "@openmapx/core";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

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

/**
 * Aggregator sources that re-publish GBFS data (Transitous indexes GBFS feeds directly,
 * NRW Mobidrom bundles operator feeds).
 * Vehicles from these sources are dropped when a direct-source vehicle with the same ID exists.
 */
const AGGREGATOR_SOURCES = new Set(["transitous", "motis", "nrw-mobidrom-scooter"]);

function isAggregator(vehicle: SharedMobilityVehicle): boolean {
  return vehicle.sources.length > 0 && vehicle.sources.every((s) => AGGREGATOR_SOURCES.has(s));
}

/**
 * Extract the operator-assigned raw vehicle ID from a namespaced vehicle ID.
 *   "gbfs/dott-berlin/2850b11e-…"  →  "2850b11e-…"
 *   "motis:2850b11e-…"             →  "2850b11e-…"
 *   "felyx/abc123"                 →  "abc123"
 */
function extractRawId(id: string): string {
  const slashIdx = id.lastIndexOf("/");
  if (slashIdx >= 0) return id.slice(slashIdx + 1);
  const colonIdx = id.lastIndexOf(":");
  if (colonIdx >= 0) return id.slice(colonIdx + 1);
  return id;
}

/**
 * Dedup free-floating vehicles across data sources using exact vehicle ID matching.
 *
 * Transitous re-publishes GBFS data and passes through the operator's original vehicle
 * IDs unchanged, so the raw ID extracted from "gbfs/dott-berlin/<uuid>" and
 * "motis:<uuid>" is identical for the same physical vehicle.
 *
 * Two-pass strategy — dedup is strictly inter-source, never intra-source:
 *
 *   Pass 1 — direct-source vehicles (GBFS, Felyx, …): all kept, indexed by raw ID.
 *   Two GBFS scooters are never compared against each other.
 *
 *   Pass 2 — aggregator vehicles (Transitous/MOTIS): looked up by raw ID against the
 *   direct-source index. On match, the aggregator's sources are merged into the
 *   direct-source vehicle for attribution and the aggregator entry is dropped. With no
 *   match, the aggregator vehicle is kept and indexed so subsequent aggregator vehicles
 *   with the same ID are also deduplicated.
 */
export function dedupVehicles(vehicles: SharedMobilityVehicle[]): SharedMobilityVehicle[] {
  const result: SharedMobilityVehicle[] = [];
  const directById = new Map<string, SharedMobilityVehicle>();
  const keptAggById = new Map<string, SharedMobilityVehicle>();

  // Pass 1: keep all direct-source vehicles, index by raw ID.
  for (const v of vehicles) {
    if (isAggregator(v)) continue;
    result.push(v);
    directById.set(extractRawId(v.id), v);
  }

  // Pass 2: merge aggregator vehicles into their direct-source counterpart, or keep them.
  for (const v of vehicles) {
    if (!isAggregator(v)) continue;
    const rawId = extractRawId(v.id);
    const directMatch = directById.get(rawId);
    if (directMatch) {
      for (const src of v.sources) {
        if (!directMatch.sources.includes(src)) directMatch.sources.push(src);
      }
      continue;
    }
    const aggMatch = keptAggById.get(rawId);
    if (aggMatch) {
      for (const src of v.sources) {
        if (!aggMatch.sources.includes(src)) aggMatch.sources.push(src);
      }
    } else {
      result.push(v);
      keptAggById.set(rawId, v);
    }
  }

  return result;
}
