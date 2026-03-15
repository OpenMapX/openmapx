/**
 * Shared GBFS data fetching logic used by bike, scooter, and car providers.
 * Handles catalog lookup, system probing, and station/vehicle extraction.
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { reverseGeocodeCity } from "../../nominatim-lookup.service.js";
import {
  filterCatalogByBbox,
  loadCatalog,
  normalizeFormFactor,
  normalizeGbfsPropulsion,
  sortByRelevance,
} from "./gbfs-catalog.js";
import { fetchGbfsSystem } from "./gbfs-client.js";
import type { SharedMobilityStation, SharedMobilityVehicle, VehicleFormFactor } from "./types.js";

const MAX_SYSTEMS_PER_SEARCH = 20;

// Operators covered by dedicated clients or known to be defunct — skip in GBFS catalog
const EXCLUDED_GBFS_PREFIXES = [
  "bird-", // Shut down in Europe (2024)
];
const _FETCH_TIMEOUT_MS = 15_000;

// In-memory cache of recently fetched system data
interface CachedSystemData {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
  expiresAt: number;
}
const systemDataCache = new Map<string, CachedSystemData>();
const SYSTEM_DATA_TTL_MS = 120_000; // 2min

function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

/** Detect GBFS station names that are internal IDs rather than human-readable. */
const GARBAGE_NAME_RE =
  /^(kml_\d+|\d+[._]\d+([._]\d+)?|station_?\d+|[A-Z]{2,5}[-_]\d+|[0-9a-f]{8,}|[-\d.,]+)$/i;

function isGarbageName(name: string): boolean {
  if (!name || name.length < 2) return true;
  return GARBAGE_NAME_RE.test(name.trim());
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

  // Sort: city-matching systems first, then scooter keywords, then rest
  const sorted = sortByRelevance(filtered, city);
  const limited = sorted.slice(0, MAX_SYSTEMS_PER_SEARCH);

  console.log(
    `[gbfs] Catalog: ${catalog.length} total, ${candidates.length} country, ${filtered.length} after exclusions, city="${city}"`,
  );

  console.log(
    `[gbfs] Probing ${limited.length} systems:`,
    limited.map((e) => e.systemId).join(", "),
  );

  const results = await Promise.allSettled(
    limited.map((entry) =>
      fetchSystemData(
        entry.systemId,
        entry.autoDiscoveryUrl,
        entry.name,
        bbox,
        targetFormFactors,
        unknownFormFactor,
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

async function fetchSystemData(
  systemId: string,
  autoDiscoveryUrl: string,
  systemName: string,
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
  unknownFormFactor: VehicleFormFactor,
): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] } | null> {
  // Check cache
  const cached = systemDataCache.get(systemId);
  if (cached && cached.expiresAt > Date.now()) {
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

  const systemData = await fetchGbfsSystem(autoDiscoveryUrl);
  if (!systemData) {
    console.log(`[gbfs] ${systemId}: discovery failed`);
    return null;
  }

  const {
    systemInfo,
    stations: stationInfos,
    stationStatuses,
    vehicles: rawVehicles,
    vehicleTypes,
  } = systemData;
  const operator = systemInfo?.operator ?? systemInfo?.name ?? systemName;
  const source = `gbfs/${systemId}`;
  const attribution = {
    label: operator,
    url: systemInfo?.url ?? "https://gbfs.org",
  };

  // When a system has no vehicle_types feed, use the caller-specified default.
  // Bike-sharing passes "bicycle", scooter-sharing passes "other".
  const defaultFormFactor: VehicleFormFactor =
    vehicleTypes.size === 0 ? unknownFormFactor : "other";

  // Detailed logging for systems that have data
  if (stationInfos.length > 0 || rawVehicles.length > 0) {
    const vtSummary = [...vehicleTypes.values()]
      .map((vt) => `${vt.vehicleTypeId}=${vt.formFactor}→${normalizeFormFactor(vt.formFactor)}`)
      .join(", ");
    console.log(
      `[gbfs] ${systemId}: ${stationInfos.length} stations, ${rawVehicles.length} raw vehicles, vtypes=[${vtSummary}], default=${defaultFormFactor}`,
    );
    // Count vehicles by filter reason
    let noCoords = 0;
    let reserved = 0;
    let atStation = 0;
    let formMismatch = 0;
    let outsideBbox = 0;
    let passed = 0;
    for (const v of rawVehicles) {
      if (v.isReserved || v.isDisabled) {
        reserved++;
        continue;
      }
      if (!v.lat || !v.lon) {
        noCoords++;
        continue;
      }
      if (v.stationId) {
        atStation++;
        continue;
      }
      const ff = getFormFactor(v.vehicleTypeId);
      if (!targetFormFactors.has(ff)) {
        formMismatch++;
        continue;
      }
      if (!bboxContains(bbox, v.lat, v.lon)) {
        outsideBbox++;
        continue;
      }
      passed++;
    }
    console.log(
      `[gbfs] ${systemId} vehicles: ${passed} pass, ${outsideBbox} outside bbox, ${formMismatch} form mismatch, ${atStation} at station, ${noCoords} no coords, ${reserved} reserved/disabled`,
    );
  } else {
    console.log(`[gbfs] ${systemId}: 0 stations, 0 vehicles`);
  }

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

    stations.push({
      id: `${source}/${stInfo.stationId}`,
      name: isGarbageName(stInfo.name) ? `${operator} Station` : stInfo.name,
      coordinates: [stInfo.lon, stInfo.lat] as LngLat,
      availableVehicles: availableCount,
      emptySlots: status.numDocksAvailable,
      capacity: stInfo.capacity,
      operator,
      vehicleTypes: stationVehicleTypes,
      isActive: true,
      source,
      attribution,
    });
  }

  // Map free-floating vehicles
  const vehicles: SharedMobilityVehicle[] = [];
  for (const v of rawVehicles) {
    if (v.isReserved || v.isDisabled) continue;
    if (!v.lat || !v.lon) continue;
    if (v.stationId) continue; // Skip vehicles at stations (already counted)

    const formFactor = getFormFactor(v.vehicleTypeId);
    if (!targetFormFactors.has(formFactor)) continue;

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
      isReserved: v.isReserved,
      isDisabled: v.isDisabled,
      operator,
      source,
      attribution,
    });
  }

  // Cache all data (pre-bbox-filter) for reuse
  systemDataCache.set(systemId, {
    stations,
    vehicles,
    expiresAt: Date.now() + SYSTEM_DATA_TTL_MS,
  });

  // Filter to bbox
  return {
    stations: stations.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0])),
    vehicles: vehicles.filter((v) => bboxContains(bbox, v.coordinates[1], v.coordinates[0])),
  };
}
