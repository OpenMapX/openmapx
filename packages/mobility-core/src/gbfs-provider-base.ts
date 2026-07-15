/**
 * Shared GBFS data fetching logic used by bike, scooter, and car providers.
 * Handles catalog lookup, system probing, and station/vehicle extraction.
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { bboxContains } from "@openmapx/core";
import { cacheGet, cacheSet, TTL } from "./cache.js";
import {
  filterCatalogByBbox,
  loadCatalog,
  normalizeFormFactor,
  normalizeGbfsPropulsion,
  probeSystem,
  sortByRelevance,
} from "./gbfs-catalog.js";
import { fetchGbfsSystem, type GbfsSystemData } from "./gbfs-client.js";
import { reverseGeocodeCity } from "./nominatim.js";
import { normalizeRentalReturnConstraint } from "./rental-constraints.js";
import type {
  PricingDetail,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
  VehicleTypeDetail,
} from "./types/shared-mobility.js";

const SYSTEM_PROBE_CONCURRENCY = 8;
const MAX_SYSTEMS_PER_SEARCH = 64;

// Operators covered by dedicated clients or known to be defunct — skip in GBFS catalog
const EXCLUDED_GBFS_PREFIXES = [
  "bird-", // Shut down in Europe (2024)
];
// Redis cache key prefix and TTL for per-system station/vehicle data
const SYSTEM_CACHE_PREFIX = "cache:gbfs:system:";
const SYSTEM_CACHE_TTL = TTL.sharedMobility.stations; // 120s
const ENTUR_GBFS_HOST = "api.entur.io/mobility/v2/gbfs/";
const ENTUR_CLIENT_NAME = "openmapx-server";
const SWISS_SHARED_MOBILITY_SYSTEM_ID = "sharedmobility.ch";
const SWISS_SHARED_MOBILITY_DISCOVERY_URL = "https://sharedmobility.ch/gbfs.json";
export const SWISS_SHARED_MOBILITY_BBOX: BoundingBox = {
  west: 5.96,
  south: 45.82,
  east: 10.49,
  north: 47.81,
};

interface CachedSystemData {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
}

/** Detect GBFS station names that are internal IDs rather than human-readable. */
const GARBAGE_NAME_RE =
  /^(kml_\d+|\d+[._]\d+([._]\d+)?|station_?\d+|[A-Z]{2,5}[-_]\d+|[0-9a-f]{8,}|[-\d.,]+)$/i;

function isGarbageName(name: string): boolean {
  if (!name || name.length < 2) return true;
  return GARBAGE_NAME_RE.test(name.trim());
}

function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

export function bboxOverlapsSwitzerland(bbox: BoundingBox): boolean {
  return bboxOverlaps(bbox, SWISS_SHARED_MOBILITY_BBOX);
}

function probeVehicleTypesMatchTarget(
  vehicleTypes: Set<string>,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor,
): boolean {
  if (vehicleTypes.size === 0) return true;
  for (const vehicleType of vehicleTypes) {
    if (targetFormFactors.has(vehicleType as VehicleFormFactor)) return true;
    if (vehicleType === "other" && targetFormFactors.has(unknownFormFactor)) return true;
  }
  return false;
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index] as T;
        try {
          results[index] = { status: "fulfilled", value: await fn(item) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}

/**
 * Fetch stations and vehicles from GBFS systems matching the bbox
 * and filter to the specified form factors.
 */
export async function fetchGbfsData(
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor = "bicycle",
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  const catalog = await loadCatalog();
  const candidates = filterCatalogByBbox(catalog, bbox);

  // Exclude operators that are defunct
  const filtered = candidates.filter(
    (e) => !EXCLUDED_GBFS_PREFIXES.some((p) => e.systemId.startsWith(p)),
  );

  if (filtered.length === 0) {
    return { stations: [], vehicles: [] };
  }

  // Reverse-geocode bbox center to determine city for prioritization
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLon = (bbox.west + bbox.east) / 2;
  const city = await reverseGeocodeCity(centerLat, centerLon);

  // Sort for deterministic probing/fetching order, then cap the fan-out so
  // large countries cannot trigger hundreds of full GBFS fetches per search.
  const sorted = sortByRelevance(filtered, city);
  const probeCandidates = sorted.slice(0, MAX_SYSTEMS_PER_SEARCH);

  const probed = await mapSettledWithConcurrency(
    probeCandidates,
    SYSTEM_PROBE_CONCURRENCY,
    async (entry) => {
      const probe = await probeSystem(entry);
      if (!probe) return null;
      if (!bboxOverlaps(probe.bbox, bbox)) return null;
      if (!probeVehicleTypesMatchTarget(probe.vehicleTypes, targetFormFactors, unknownFormFactor)) {
        return null;
      }
      return { entry, systemData: probe.systemData };
    },
  );
  const matchingEntries: Array<{
    entry: (typeof probeCandidates)[number];
    systemData?: GbfsSystemData;
  }> = [];
  for (const result of probed) {
    if (result.status === "fulfilled" && result.value) {
      matchingEntries.push(result.value);
    }
  }

  const results = await Promise.allSettled(
    matchingEntries.map(({ entry, systemData }) =>
      fetchSystemData(
        entry.systemId,
        entry.autoDiscoveryUrl,
        entry.name,
        bbox,
        targetFormFactors,
        unknownFormFactor,
        systemData,
      ),
    ),
  );

  const stations: SharedMobilityStation[] = [];
  const vehicles: SharedMobilityVehicle[] = [];

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      stations.push(...r.value.stations);
      vehicles.push(...r.value.vehicles);
    }
  }

  return { stations, vehicles };
}

/**
 * Dedicated Swiss shared mobility entrypoint.
 * Uses the official sharedmobility.ch GBFS discovery feed directly so Swiss
 * coverage works even when the global GBFS catalog is stale or under-ranked.
 */
export async function fetchSwissSharedMobilityData(
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor = "bicycle",
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  const result = await fetchSystemData(
    SWISS_SHARED_MOBILITY_SYSTEM_ID,
    SWISS_SHARED_MOBILITY_DISCOVERY_URL,
    "sharedmobility.ch",
    bbox,
    targetFormFactors,
    unknownFormFactor,
  );
  return result ?? { stations: [], vehicles: [] };
}

export async function fetchSwissSharedMobilityDataForBbox(
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor = "bicycle",
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  if (!bboxOverlapsSwitzerland(bbox)) {
    return { stations: [], vehicles: [] };
  }
  return fetchSwissSharedMobilityData(bbox, targetFormFactors, unknownFormFactor);
}

async function fetchSystemData(
  systemId: string,
  autoDiscoveryUrl: string,
  systemName: string,
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor,
  prefetchedSystemData?: GbfsSystemData,
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] } | null> {
  // Check Redis cache (persists across requests with different bboxes)
  const cacheKey = `${SYSTEM_CACHE_PREFIX}${systemId}:${[...targetFormFactors].sort().join(",")}:${unknownFormFactor}`;
  const cached = await cacheGet<CachedSystemData>(cacheKey);
  if (cached) {
    return {
      stations: cached.stations.filter(
        (s) =>
          bboxContains(bbox, s.coordinates[1], s.coordinates[0]) &&
          s.vehicleTypes.some((vt) => targetFormFactors.has(vt)),
      ),
      vehicles: cached.vehicles.filter(
        (v) =>
          bboxContains(bbox, v.coordinates[1], v.coordinates[0]) &&
          targetFormFactors.has(v.formFactor),
      ),
    };
  }

  const systemData =
    prefetchedSystemData ??
    (await fetchGbfsSystem(autoDiscoveryUrl, getGbfsDiscoveryHeaders(autoDiscoveryUrl)));
  if (!systemData) {
    return null;
  }

  const {
    systemInfo,
    stations: stationInfos,
    stationStatuses,
    vehicles: rawVehicles,
    vehicleTypes,
    pricingPlans,
  } = systemData;
  const operator = (systemInfo?.operator ?? systemInfo?.name ?? systemName).replace(/\b\w/g, (c) =>
    c.toUpperCase(),
  );
  const source = `gbfs/${systemId}`;

  // When a system has no vehicle_types feed, use the caller-specified default.
  // Bike-sharing passes "bicycle", scooter-sharing passes "other".
  const defaultFormFactor: VehicleFormFactor =
    vehicleTypes.size === 0 ? unknownFormFactor : "other";

  function getFormFactor(vehicleTypeId?: string): VehicleFormFactor {
    if (!vehicleTypeId) return defaultFormFactor;
    const vt = vehicleTypes.get(vehicleTypeId);
    return vt ? normalizeFormFactor(vt.formFactor) : defaultFormFactor;
  }

  // Map stations
  const stations: SharedMobilityStation[] = [];
  for (const stInfo of stationInfos) {
    const status = stationStatuses.get(stInfo.stationId);
    if (!status) continue;
    if (!status.isInstalled || !status.isRenting) continue;

    // Determine vehicle types at this station
    const stationVehicleTypes: VehicleFormFactor[] = [];
    if (status.vehicleTypesAvailable) {
      for (const vta of status.vehicleTypesAvailable) {
        const ff = getFormFactor(vta.vehicleTypeId);
        if (!stationVehicleTypes.includes(ff)) stationVehicleTypes.push(ff);
      }
    } else if (stInfo.vehicleTypesAvailable) {
      for (const vtId of stInfo.vehicleTypesAvailable) {
        const ff = getFormFactor(vtId);
        if (!stationVehicleTypes.includes(ff)) stationVehicleTypes.push(ff);
      }
    } else {
      stationVehicleTypes.push(defaultFormFactor);
    }

    // Filter availability count to target form factors
    let availableCount = 0;
    if (status.vehicleTypesAvailable) {
      for (const vta of status.vehicleTypesAvailable) {
        if (targetFormFactors.has(getFormFactor(vta.vehicleTypeId))) {
          availableCount += vta.count;
        }
      }
    } else if (stationVehicleTypes.some((vt) => targetFormFactors.has(vt))) {
      availableCount = status.numBikesAvailable;
    }

    if (!stationVehicleTypes.some((vt) => targetFormFactors.has(vt))) continue;

    // Collect vehicle type details for this station
    const vtDetails: VehicleTypeDetail[] = [];
    const pricingPlanIds = new Set<string>();
    const vtIds =
      status.vehicleTypesAvailable?.map((v) => v.vehicleTypeId) ??
      stInfo.vehicleTypesAvailable ??
      [];
    for (const vtId of vtIds) {
      const vt = vehicleTypes.get(vtId);
      if (!vt || !targetFormFactors.has(normalizeFormFactor(vt.formFactor))) continue;
      vtDetails.push({
        id: vt.vehicleTypeId,
        name: vt.name ?? `${vt.make ?? ""} ${vt.model ?? ""}`.trim(),
        formFactor: normalizeFormFactor(vt.formFactor),
        make: vt.make,
        model: vt.model,
        propulsion: vt.propulsionType,
        accessories: vt.vehicleAccessories,
        co2PerKm: vt.co2PerKm,
        riderCapacity: vt.riderCapacity,
        returnConstraint: normalizeRentalReturnConstraint(vt.returnConstraint),
      });
      if (vt.defaultPricingPlanId) pricingPlanIds.add(vt.defaultPricingPlanId);
      for (const pid of vt.pricingPlanIds ?? []) pricingPlanIds.add(pid);
    }

    // Collect pricing details
    const pricingDetails: PricingDetail[] = [];
    let cheapestUnlock: number | undefined;
    let cheapestPerKm: number | undefined;
    let cheapestPerHour: number | undefined;
    for (const pid of pricingPlanIds) {
      const pp = pricingPlans.get(pid);
      if (!pp) continue;
      const perKmRate = pp.perKmPricing?.[0]?.rate;
      // Normalize per_min_pricing to hourly: rate is per interval minutes
      const minPricing = pp.perMinPricing?.[0];
      const perHourRate =
        minPricing && minPricing.interval > 0
          ? (minPricing.rate / minPricing.interval) * 60
          : undefined;
      const flatRate = pp.price > 0 ? pp.price : undefined;
      if (flatRate !== undefined && (cheapestUnlock === undefined || flatRate < cheapestUnlock))
        cheapestUnlock = flatRate;
      if (perKmRate !== undefined && (cheapestPerKm === undefined || perKmRate < cheapestPerKm))
        cheapestPerKm = perKmRate;
      if (
        perHourRate !== undefined &&
        perHourRate > 0 &&
        (cheapestPerHour === undefined || perHourRate < cheapestPerHour)
      )
        cheapestPerHour = perHourRate;
      pricingDetails.push({
        name: pp.name,
        description: pp.description,
        currency: pp.currency,
        perKmRate,
        perHourRate: perHourRate && perHourRate > 0 ? perHourRate : undefined,
        flatRate,
      });
    }

    // Build compact pricing summary (shown in the Availability table row)
    let pricingSummary: string | undefined;
    if (
      cheapestUnlock !== undefined ||
      cheapestPerKm !== undefined ||
      cheapestPerHour !== undefined
    ) {
      const parts: string[] = [];
      if (cheapestUnlock !== undefined) parts.push(`${cheapestUnlock.toFixed(2)} €`);
      if (cheapestPerKm !== undefined) parts.push(`${cheapestPerKm.toFixed(2)} €/km`);
      if (cheapestPerHour !== undefined) parts.push(`${cheapestPerHour.toFixed(2)} €/h`);
      pricingSummary = parts.join(" + ");
    }

    stations.push({
      id: `${source}/${stInfo.stationId}`,
      name: isGarbageName(stInfo.name) ? `${operator} Station` : stInfo.name,
      coordinates: [stInfo.lon, stInfo.lat] as LngLat,
      availableVehicles: availableCount,
      emptySlots: status.numDocksAvailable,
      capacity: stInfo.capacity,
      systemId,
      nativeId: stInfo.stationId,
      operator,
      vehicleTypes: stationVehicleTypes,
      vehicleTypeIds: vtIds.filter((vtId) => targetFormFactors.has(getFormFactor(vtId))),
      isActive: true,
      sources: [source],
      website: stInfo.rentalUris?.web,
      rentalUris: stInfo.rentalUris,
      vehicleTypeDetails: vtDetails.length > 0 ? vtDetails : undefined,
      pricingSummary,
      pricingDetails: pricingDetails.length > 0 ? pricingDetails : undefined,
    });
  }

  // Map free-floating vehicles — include ALL form factors so the cached entry can be
  // shared across providers (bike-sharing, scooter-sharing, car-sharing). Form factor
  // filtering happens on cache retrieval below.
  const vehicles: SharedMobilityVehicle[] = [];
  for (const v of rawVehicles) {
    if (v.isReserved || v.isDisabled) continue;
    if (!v.lat || !v.lon) continue;
    if (v.stationId) continue; // Skip vehicles at stations (already counted)

    const formFactor = getFormFactor(v.vehicleTypeId);
    const vt = v.vehicleTypeId ? vehicleTypes.get(v.vehicleTypeId) : null;

    vehicles.push({
      id: `${source}/${v.bikeId}`,
      coordinates: [v.lon, v.lat] as LngLat,
      formFactor,
      propulsion: vt
        ? (normalizeGbfsPropulsion(vt.propulsionType) as SharedMobilityVehicle["propulsion"])
        : undefined,
      batteryLevel:
        v.currentFuelPercent != null ? Math.round(v.currentFuelPercent * 100) : undefined,
      rangeMeters: v.currentRangeMeters,
      systemId,
      nativeId: v.bikeId,
      vehicleTypeId: v.vehicleTypeId,
      isReserved: v.isReserved,
      isDisabled: v.isDisabled,
      operator,
      sources: [source],
    });
  }

  // Cache all data (pre-bbox-filter, all form factors) in Redis for reuse across providers/bboxes
  await cacheSet(cacheKey, { stations, vehicles }, SYSTEM_CACHE_TTL);

  // Filter to bbox and target form factors
  return {
    stations: stations.filter(
      (s) =>
        bboxContains(bbox, s.coordinates[1], s.coordinates[0]) &&
        s.vehicleTypes.some((vt) => targetFormFactors.has(vt)),
    ),
    vehicles: vehicles.filter(
      (v) =>
        bboxContains(bbox, v.coordinates[1], v.coordinates[0]) &&
        targetFormFactors.has(v.formFactor),
    ),
  };
}

function getGbfsDiscoveryHeaders(autoDiscoveryUrl: string): Record<string, string> | undefined {
  if (autoDiscoveryUrl.includes(ENTUR_GBFS_HOST)) {
    return { "ET-Client-Name": ENTUR_CLIENT_NAME };
  }
  return undefined;
}
