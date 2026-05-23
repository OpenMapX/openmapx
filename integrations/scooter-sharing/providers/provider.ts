/**
 * Scooter Sharing data source provider.
 * Combines GBFS scooter feeds + Felyx + GO Sharing + Link + NRW Mobidrom + MOTIS/Transitous.
 * Handles both free-floating vehicles and docked stations.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { MobilityDataSourceProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { dedupStations, dedupVehicles } from "@openmapx/mobility-core/dedup";
import {
  buildEnturGeofencingMapContext,
  enrichEnturMobilityItems,
} from "@openmapx/mobility-core/entur-mobility";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/mobility-core/gbfs-provider-base";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "@openmapx/mobility-core/mapper";
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/mobility-core/shared-mobility";
import { searchFelyx } from "./felyx-client.js";
import { searchGoSharing } from "./gosharing-client.js";
import { searchLink } from "./link-client.js";
import { searchNrwMobidrom } from "./nrw-mobidrom-client.js";

// In-memory cache for detail lookups
const itemCache = new Map<string, SharedMobilityStation | SharedMobilityVehicle>();
const MAX_CACHE_SIZE = 5000;

const META: DataSourceMeta = {
  minZoom: 13,
  markerStyle: {
    type: "circle",
    variantColors: {
      available: "#7C4DFF",
      high_battery: "#4CAF50",
      medium_battery: "#FF9800",
      low_battery: "#F44336",
      reserved: "#9E9E9E",
      disabled: "#9E9E9E",
      full: "#7C4DFF",
      empty: "#BDBDBD",
      inactive: "#9E9E9E",
    },
    defaultColor: "#7C4DFF",
    inactiveOpacity: 0.5,
    iconPath:
      "M7.82 16H15v-1c0-2.21 1.79-4 4-4h.74l-1.22-3H15V6c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H5.5c-.66 0-1.21.42-1.42 1.01L2 16v2c0 1.1.9 2 2 2h1c0 1.66 1.34 3 3 3s3-1.34 3-3h2c0 1.66 1.34 3 3 3s3-1.34 3-3h1c1.1 0 2-.9 2-2v-2H7.82zM8 20c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m8 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1",
  },
  showResultsList: true,
  placeCategory: "E-Scooter",
  placeCategoryRaw: "scooter_rental",
};

const SCOOTER_FORM_FACTORS = new Set<import("./types.js").VehicleFormFactor>([
  "scooter_standing",
  "scooter_seated",
  "moped",
]);

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "gbfs",
    name: "GBFS Catalog (MobilityData)",
    url: "https://github.com/MobilityData/mobility-feeds-api",
  },
];

const wrapRT = <T>(data: T): MobilityResult<T> =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
const wrapStatic = <T>(data: T): MobilityResult<T> =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: false }));

class ScooterSharingProvider implements MobilityDataSourceProvider {
  readonly id = "scooter-sharing";
  readonly meta = META;
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;
  readonly mapContextCacheTtl = 300;
  readonly attribution = ATTRIBUTION;

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return [];
  }

  async search(bbox: BoundingBox): Promise<MobilityResult<DataSourceResult[]>> {
    const bboxArray: [number, number, number, number] = [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
    ];

    // Fetch from all sources in parallel
    const [
      gbfsResult,
      swissGbfsResult,
      felyxResult,
      goSharingResult,
      linkResult,
      nrwResult,
      motisResult,
    ] = await Promise.allSettled([
      fetchGbfsData(bbox, SCOOTER_FORM_FACTORS, "other"),
      fetchSwissSharedMobilityDataForBbox(bbox, SCOOTER_FORM_FACTORS, "other"),
      searchFelyx(bbox),
      searchGoSharing(bbox),
      searchLink(bbox),
      searchNrwMobidrom(bbox),
      fetchMotisRentals(bboxArray, ["scooter_standing", "scooter_seated", "moped"]),
    ]);

    const results: DataSourceResult[] = [];

    // Collect stations from all sources for deduplication
    const allStations: SharedMobilityStation[] = [];
    if (gbfsResult.status === "fulfilled") {
      allStations.push(...gbfsResult.value.stations);
    }
    if (swissGbfsResult.status === "fulfilled") {
      allStations.push(...swissGbfsResult.value.stations);
    }
    // Aggregator stations (appended last so direct GBFS takes dedup priority)
    if (nrwResult.status === "fulfilled") {
      allStations.push(...nrwResult.value.stations);
    }
    if (motisResult.status === "fulfilled") {
      allStations.push(...motisResult.value.stations);
    }

    // Collect all free-floating vehicles: direct sources first, aggregators last.
    // dedupVehicles drops aggregator (NRW Mobidrom, MOTIS/Transitous) vehicles that have a
    // direct-source counterpart with the same raw vehicle ID.
    const allVehicles: SharedMobilityVehicle[] = [];
    if (gbfsResult.status === "fulfilled") allVehicles.push(...gbfsResult.value.vehicles);
    if (swissGbfsResult.status === "fulfilled") allVehicles.push(...swissGbfsResult.value.vehicles);
    if (felyxResult.status === "fulfilled") allVehicles.push(...felyxResult.value);
    if (goSharingResult.status === "fulfilled") allVehicles.push(...goSharingResult.value);
    if (linkResult.status === "fulfilled") allVehicles.push(...linkResult.value);
    if (nrwResult.status === "fulfilled") allVehicles.push(...nrwResult.value.vehicles);
    if (motisResult.status === "fulfilled") allVehicles.push(...motisResult.value.vehicles);

    const dedupedStations = dedupStations(allStations);
    const dedupedVehicles = dedupVehicles(allVehicles);

    try {
      await enrichEnturMobilityItems(dedupedStations, dedupedVehicles);
    } catch (error) {
      console.warn("[scooter-sharing] Entur enrichment failed", error);
    }

    for (const station of dedupedStations) {
      updateCache(station.id, station);
      results.push(mapStationToResult(station));
    }

    for (const vehicle of dedupedVehicles) {
      updateCache(vehicle.id, vehicle);
      results.push(mapVehicleToResult(vehicle));
    }

    return wrapRT(results);
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const cached = itemCache.get(itemId);
    if (cached) {
      if ("availableVehicles" in cached) return wrapRT(mapStationToDetail(cached));
      return wrapRT(mapVehicleToDetail(cached));
    }

    return wrapRT(null);
  }

  async getMapContext(
    bbox: BoundingBox,
    _filters?: Record<string, unknown>,
    options?: { systemIds?: string[]; vehicleTypeIds?: string[] },
  ) {
    return wrapStatic(await buildEnturGeofencingMapContext(bbox, options));
  }
}

function updateCache(id: string, item: SharedMobilityStation | SharedMobilityVehicle): void {
  if (itemCache.size >= MAX_CACHE_SIZE) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
  itemCache.set(id, item);
}

export const scooterSharingProvider = new ScooterSharingProvider();
