/**
 * Enrichment merge for regional car-sharing stations.
 *
 * When multiple sources report the same station (by proximity within 50m),
 * keeps the first occurrence's live data (availability, operator, name) but
 * enriches it with extra fields from later occurrences that the first one lacks
 * (address, website, location hints, vehicle classes, etc.).
 *
 * Attributions from ALL merged sources are collected so every data contributor
 * is credited in the detail view.
 *
 * Registration order determines priority: Cambio (live API) should be registered
 * before open data sources so its live availability numbers are kept.
 */

import { mergeAttributions } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/integration-shared-mobility/types";

/** Maximum distance in meters to consider two stations as the same location. */
const MERGE_RADIUS_M = 50;

/** Approximate distance between two WGS84 points in meters (Haversine-lite). */
function distanceM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const avgLat = ((lat1 + lat2) / 2) * toRad;
  // Equirectangular approximation — accurate enough at short distances
  const x = dLng * Math.cos(avgLat);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/**
 * Find an existing station within MERGE_RADIUS_M of the given coordinates.
 * Returns the index or -1 if none found.
 */
function findNearby(stations: SharedMobilityStation[], lng: number, lat: number): number {
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (distanceM(lng, lat, s.coordinates[0], s.coordinates[1]) <= MERGE_RADIUS_M) {
      return i;
    }
  }
  return -1;
}

/**
 * Merge stations by proximity (within 50m).
 * First-seen station wins for identity and availability.
 * Later stations at nearby coordinates contribute enrichment fields
 * and their attributions are collected.
 */
export function mergeRegionalStations(stations: SharedMobilityStation[]): SharedMobilityStation[] {
  const merged: SharedMobilityStation[] = [];

  for (const s of stations) {
    const idx = findNearby(merged, s.coordinates[0], s.coordinates[1]);

    if (idx === -1) {
      // No nearby match — add as new (clone to avoid mutating input/cached objects)
      merged.push({ ...s });
      continue;
    }

    const existing = merged[idx];

    // Merge attributions from all contributing sources
    existing.attribution = mergeAttributions(existing.attribution, s.attribution);

    // Enrich the primary station with fields from the secondary source.
    // Only copy fields that the primary source doesn't already have.
    if (!existing.address && s.address) existing.address = s.address;
    if (!existing.website && s.website) existing.website = s.website;
    if (!existing.locationHint && s.locationHint) existing.locationHint = s.locationHint;
    if (!existing.operatorNotes && s.operatorNotes) existing.operatorNotes = s.operatorNotes;
    if (!existing.transitInfo && s.transitInfo) existing.transitInfo = s.transitInfo;
    if (!existing.accessMethod && s.accessMethod) existing.accessMethod = s.accessMethod;
    if (!existing.vehicleClassNames && s.vehicleClassNames)
      existing.vehicleClassNames = s.vehicleClassNames;
    if (!existing.stationType && s.stationType) existing.stationType = s.stationType;
    if (existing.capacity === undefined && s.capacity !== undefined) existing.capacity = s.capacity;
    // Do NOT override: availableVehicles, isActive, operator, name, id, source
    // These come from the primary (live) source.
  }

  return merged;
}
