/**
 * Car Sharing data source provider.
 * Combines GBFS car feeds + registered regional car-sharing clients.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import { dedupStations, dedupVehicles } from "@openmapx/integration-shared-mobility/dedup";
import {
  buildEnturGeofencingMapContext,
  enrichEnturMobilityItems,
} from "@openmapx/integration-shared-mobility/entur-mobility";
import {
  fetchGbfsData,
  fetchSwissSharedMobilityDataForBbox,
} from "@openmapx/integration-shared-mobility/gbfs-provider-base";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "@openmapx/integration-shared-mobility/mapper";
import { fetchMotisRentals } from "@openmapx/integration-shared-mobility/motis-rentals";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/integration-shared-mobility/types";
import type { DataSourceProvider } from "../../data-source/types.js";
import { mergeRegionalStations } from "./merge-stations.js";
import { searchRegionalClients } from "./registry.js";

// In-memory cache for detail lookups
const itemCache = new Map<string, SharedMobilityStation | SharedMobilityVehicle>();
const MAX_CACHE_SIZE = 3000;

const META: DataSourceMeta = {
  minZoom: 12,
  markerStyle: {
    type: "icon",
    variantColors: {
      available: "#2196F3",
      full: "#FF9800",
      empty: "#F44336",
      inactive: "#9E9E9E",
    },
    defaultColor: "#2196F3",
    inactiveOpacity: 0.5,
    iconPath:
      "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16m11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5M5 11l1.5-4.5h11L19 11z",
  },
  showResultsList: true,
  placeCategory: "Car Sharing Station",
  placeCategoryRaw: "car_sharing",
  osmFilters: CATEGORY_FILTERS.car_sharing,
};

const CAR_FORM_FACTORS = new Set<import("./types.js").VehicleFormFactor>(["car"]);

class CarSharingProvider implements DataSourceProvider {
  readonly id = "car-sharing";
  readonly meta = META;
  readonly searchCacheTtl = 300;
  readonly detailCacheTtl = 300;
  readonly mapContextCacheTtl = 300;

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return [];
  }

  async search(bbox: BoundingBox): Promise<DataSourceResult[]> {
    const bboxArray: [number, number, number, number] = [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
    ];

    // Fetch from registered regional clients and GBFS in parallel
    const [regionalResult, gbfsResult, swissGbfsResult, motisResult] = await Promise.allSettled([
      searchRegionalClients(bbox),
      fetchGbfsData(bbox, CAR_FORM_FACTORS),
      fetchSwissSharedMobilityDataForBbox(bbox, CAR_FORM_FACTORS),
      fetchMotisRentals(bboxArray, ["car"]),
    ]);

    const allStations: SharedMobilityStation[] = [];
    const results: DataSourceResult[] = [];

    // Regional clients first (known reliable sources, higher priority for dedup).
    // mergeRegionalStations keeps the first occurrence's live availability data
    // but enriches it with extra fields (address, website, description) from
    // later occurrences at the same coordinates.
    if (regionalResult.status === "fulfilled") {
      const merged = mergeRegionalStations(regionalResult.value);
      for (const station of merged) {
        updateCache(station.id, station);
        results.push(mapStationToResult(station));
      }
    }

    // GBFS stations (collected for dedup with MOTIS)
    if (gbfsResult.status === "fulfilled") {
      allStations.push(...gbfsResult.value.stations);
    }
    if (swissGbfsResult.status === "fulfilled") {
      allStations.push(...swissGbfsResult.value.stations);
    }

    // MOTIS/Transitous stations (appended last so existing sources take dedup priority)
    if (motisResult.status === "fulfilled") {
      allStations.push(...motisResult.value.stations);
    }

    // Collect all free-floating vehicles: GBFS first, MOTIS last.
    const allVehicles: SharedMobilityVehicle[] = [];
    if (gbfsResult.status === "fulfilled") allVehicles.push(...gbfsResult.value.vehicles);
    if (swissGbfsResult.status === "fulfilled") allVehicles.push(...swissGbfsResult.value.vehicles);
    if (motisResult.status === "fulfilled") allVehicles.push(...motisResult.value.vehicles);

    const dedupedStations = dedupStations(allStations);
    const dedupedVehicles = dedupVehicles(allVehicles);

    try {
      await enrichEnturMobilityItems(dedupedStations, dedupedVehicles);
    } catch (error) {
      console.warn("[car-sharing] Entur enrichment failed", error);
    }

    for (const station of dedupedStations) {
      updateCache(station.id, station);
      results.push(mapStationToResult(station));
    }

    for (const vehicle of dedupedVehicles) {
      updateCache(vehicle.id, vehicle);
      results.push(mapVehicleToResult(vehicle));
    }

    return results;
  }

  async getDetail(itemId: string): Promise<DataSourceDetail | null> {
    const cached = itemCache.get(itemId);
    if (cached) {
      if ("availableVehicles" in cached) return mapStationToDetail(cached);
      return mapVehicleToDetail(cached);
    }

    return null;
  }

  async getMapContext(
    bbox: BoundingBox,
    _filters?: Record<string, unknown>,
    options?: { systemIds?: string[]; vehicleTypeIds?: string[] },
  ) {
    return buildEnturGeofencingMapContext(bbox, options);
  }
}

function updateCache(id: string, item: SharedMobilityStation | SharedMobilityVehicle): void {
  if (itemCache.size >= MAX_CACHE_SIZE) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
  itemCache.set(id, item);
}

export const carSharingProvider = new CarSharingProvider();
