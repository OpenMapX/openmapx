/**
 * Coordinate-based deduplication for shared mobility results.
 * Two stations within ~11m are considered duplicates (primary check).
 * A secondary fuzzy check catches near-misses: within 50m + name similarity > 0.6.
 */

import { diceSimilarity, haversineMeters } from "@openmapx/core";
import { DEDUP } from "./policy.js";
import type {
  PricingDetail,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleTypeDetail,
} from "./types/shared-mobility.js";

/**
 * Round to 4 decimal places (~11m precision). Matches
 * `DEDUP.STATION_RADIUS_M` (the canonical station-match radius).
 */
function coordKey(lng: number, lat: number): string {
  return `${lng.toFixed(4)},${lat.toFixed(4)}`;
}

function mergeUnique<T>(
  current: T[] | undefined,
  incoming: T[] | undefined,
  keyFn?: (item: T) => string,
): T[] | undefined {
  if ((!current || current.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = [...(current ?? [])];
  if (keyFn) {
    const seen = new Set(merged.map(keyFn));
    for (const item of incoming ?? []) {
      const key = keyFn(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }
  for (const item of incoming ?? []) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

function vehicleTypeDetailKey(v: VehicleTypeDetail): string {
  return (
    v.id ?? [v.formFactor ?? "", v.make ?? "", v.model ?? "", v.propulsion ?? "", v.name].join("|")
  );
}

function pricingDetailKey(p: PricingDetail): string {
  return [p.name, p.currency, p.flatRate ?? "", p.perKmRate ?? "", p.perHourRate ?? ""].join("|");
}

function mergeStation(existing: SharedMobilityStation, incoming: SharedMobilityStation): void {
  existing.sources = mergeUnique(existing.sources, incoming.sources) ?? existing.sources;
  existing.vehicleTypes =
    mergeUnique(existing.vehicleTypes, incoming.vehicleTypes) ?? existing.vehicleTypes;
  existing.vehicleTypeIds =
    mergeUnique(existing.vehicleTypeIds, incoming.vehicleTypeIds) ?? existing.vehicleTypeIds;
  if (!existing.systemId && incoming.systemId) existing.systemId = incoming.systemId;
  if (!existing.nativeId && incoming.nativeId) existing.nativeId = incoming.nativeId;
  if (!existing.operator && incoming.operator) existing.operator = incoming.operator;
  if (!existing.branding && incoming.branding) {
    existing.branding = incoming.branding;
  } else if (existing.branding && incoming.branding) {
    existing.branding = {
      name: existing.branding.name ?? incoming.branding.name,
      legalName: existing.branding.legalName ?? incoming.branding.legalName,
      logoUrl: existing.branding.logoUrl ?? incoming.branding.logoUrl,
      logoUrlDark: existing.branding.logoUrlDark ?? incoming.branding.logoUrlDark,
      color: existing.branding.color ?? incoming.branding.color,
    };
  }
  if (existing.emptySlots === undefined && incoming.emptySlots !== undefined) {
    existing.emptySlots = incoming.emptySlots;
  }
  if (existing.capacity === undefined && incoming.capacity !== undefined) {
    existing.capacity = incoming.capacity;
  }
  if (!existing.isActive && incoming.isActive) existing.isActive = true;
  if (!existing.accessMethod && incoming.accessMethod)
    existing.accessMethod = incoming.accessMethod;
  if (!existing.transitInfo && incoming.transitInfo) existing.transitInfo = incoming.transitInfo;
  if (!existing.locationHint && incoming.locationHint)
    existing.locationHint = incoming.locationHint;
  if (!existing.stationType && incoming.stationType) existing.stationType = incoming.stationType;
  existing.vehicleClassNames =
    mergeUnique(existing.vehicleClassNames, incoming.vehicleClassNames) ??
    existing.vehicleClassNames;
  const mergedAddress = {
    street: existing.address?.street ?? incoming.address?.street,
    city: existing.address?.city ?? incoming.address?.city,
    postcode: existing.address?.postcode ?? incoming.address?.postcode,
    country: existing.address?.country ?? incoming.address?.country,
  };
  if (
    mergedAddress.street ||
    mergedAddress.city ||
    mergedAddress.postcode ||
    mergedAddress.country
  ) {
    existing.address = mergedAddress;
  }
  if (!existing.operatorNotes && incoming.operatorNotes)
    existing.operatorNotes = incoming.operatorNotes;
  if (!existing.website && incoming.website) existing.website = incoming.website;
  if (!existing.rentalApps && incoming.rentalApps) {
    existing.rentalApps = incoming.rentalApps;
  } else if (existing.rentalApps && incoming.rentalApps) {
    existing.rentalApps = {
      ios: {
        storeUri: existing.rentalApps.ios?.storeUri ?? incoming.rentalApps.ios?.storeUri,
        discoveryUri:
          existing.rentalApps.ios?.discoveryUri ?? incoming.rentalApps.ios?.discoveryUri,
      },
      android: {
        storeUri: existing.rentalApps.android?.storeUri ?? incoming.rentalApps.android?.storeUri,
        discoveryUri:
          existing.rentalApps.android?.discoveryUri ?? incoming.rentalApps.android?.discoveryUri,
      },
    };
  }
  if (!existing.stationArea && incoming.stationArea) existing.stationArea = incoming.stationArea;
  existing.vehicleTypeDetails =
    mergeUnique(existing.vehicleTypeDetails, incoming.vehicleTypeDetails, vehicleTypeDetailKey) ??
    existing.vehicleTypeDetails;
  if (!existing.pricingSummary && incoming.pricingSummary)
    existing.pricingSummary = incoming.pricingSummary;
  existing.pricingDetails =
    mergeUnique(existing.pricingDetails, incoming.pricingDetails, pricingDetailKey) ??
    existing.pricingDetails;
  const mergedRentalUris = {
    web: existing.rentalUris?.web ?? incoming.rentalUris?.web,
    android: existing.rentalUris?.android ?? incoming.rentalUris?.android,
    ios: existing.rentalUris?.ios ?? incoming.rentalUris?.ios,
  };
  if (mergedRentalUris.web || mergedRentalUris.android || mergedRentalUris.ios) {
    existing.rentalUris = mergedRentalUris;
  }
}

/**
 * Dedup stations by coordinates, with a secondary fuzzy name+distance check.
 * First-seen wins (priority order in input).
 */
export function dedupStations(stations: SharedMobilityStation[]): SharedMobilityStation[] {
  const byCoordKey = new Map<string, SharedMobilityStation>();
  const byIdentity = new Map<string, SharedMobilityStation>();
  const result: SharedMobilityStation[] = [];

  for (const s of stations) {
    const scope = s.systemId ?? s.providerId ?? [...s.sources].sort().join("+");
    const nativeId = s.nativeId;
    const identity = nativeId ? `${scope}\0${nativeId}` : undefined;
    const identityMatch = identity ? byIdentity.get(identity) : undefined;
    if (identityMatch) {
      mergeStation(identityMatch, s);
      continue;
    }
    const key = `${scope}\0${coordKey(s.coordinates[0], s.coordinates[1])}`;
    const exactMatch = byCoordKey.get(key);
    if (exactMatch) {
      mergeStation(exactMatch, s);
      if (identity) byIdentity.set(identity, exactMatch);
      continue;
    }

    const fuzzyMatch = result.find((existing) => {
      const existingScope =
        existing.systemId ?? existing.providerId ?? [...existing.sources].sort().join("+");
      if (existingScope !== scope) return false;
      const dist = haversineMeters(
        s.coordinates[1],
        s.coordinates[0],
        existing.coordinates[1],
        existing.coordinates[0],
      );
      if (dist > DEDUP.STOP_RADIUS_M) return false;
      const nameA = s.name.toLowerCase().trim();
      const nameB = existing.name.toLowerCase().trim();
      return diceSimilarity(nameA, nameB) > DEDUP.NAME_SIMILARITY_MIN;
    });

    if (fuzzyMatch) {
      mergeStation(fuzzyMatch, s);
      if (identity) byIdentity.set(identity, fuzzyMatch);
      continue;
    }

    byCoordKey.set(key, s);
    if (identity) byIdentity.set(identity, s);
    result.push(s);
  }

  return result;
}

/**
 * Aggregator sources that re-publish GBFS data (Transitous indexes GBFS feeds directly,
 * NRW Mobidrom bundles operator feeds).
 * Vehicles from these sources are dropped when a direct-source vehicle with the same ID exists.
 */
const AGGREGATOR_SOURCES = new Set(["transitous", "motis", "de-nw-mobidrom-scooter"]);

function isAggregator(vehicle: SharedMobilityVehicle): boolean {
  if (vehicle.servingOrigin === "motis-local" || vehicle.servingOrigin === "transitous")
    return true;
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

function canonicalVehicleIdentity(vehicle: SharedMobilityVehicle): string {
  const provider = vehicle.systemId ?? vehicle.providerId ?? [...vehicle.sources].sort().join("+");
  const native = vehicle.nativeId ?? extractRawId(vehicle.id);
  return `${provider}\0${native}`;
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
    directById.set(canonicalVehicleIdentity(v), v);
  }

  // Pass 2: merge aggregator vehicles into their direct-source counterpart, or keep them.
  for (const v of vehicles) {
    if (!isAggregator(v)) continue;
    const identity = canonicalVehicleIdentity(v);
    const directMatch = directById.get(identity);
    if (directMatch) {
      for (const src of v.sources) {
        if (!directMatch.sources.includes(src)) directMatch.sources.push(src);
      }
      continue;
    }
    const aggMatch = keptAggById.get(identity);
    if (aggMatch) {
      for (const src of v.sources) {
        if (!aggMatch.sources.includes(src)) aggMatch.sources.push(src);
      }
    } else {
      result.push(v);
      keptAggById.set(identity, v);
    }
  }

  return result;
}
