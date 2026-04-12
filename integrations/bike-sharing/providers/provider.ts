/**
 * Bike Sharing data source provider.
 * Combines CityBikes API + GBFS bicycle feeds + Nextbike + Donkey Republic.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { dedupStations } from "@openmapx/integration-shared-mobility/dedup";
import { fetchGbfsData } from "@openmapx/integration-shared-mobility/gbfs-provider-base";
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
import { searchCityBikes } from "./citybikes-client.js";
import { searchDbBikes } from "./db-bike-client.js";
import { searchDonkey } from "./donkey-client.js";
import { searchNextbike } from "./nextbike-client.js";

const BIKE_FORM_FACTORS = new Set<
  import("@openmapx/integration-shared-mobility/types").VehicleFormFactor
>(["bicycle", "cargo_bicycle"]);

// In-memory cache for detail lookups (stations + free-floating)
const itemCache = new Map<string, SharedMobilityStation | SharedMobilityVehicle>();
const MAX_CACHE_SIZE = 5000;

function updateCache(id: string, item: SharedMobilityStation | SharedMobilityVehicle): void {
  if (itemCache.size >= MAX_CACHE_SIZE) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
  itemCache.set(id, item);
}

const META: DataSourceMeta = {
  minZoom: 12,
  markerStyle: {
    type: "icon",
    variantColors: {
      available: "#4CAF50",
      full: "#FF9800",
      empty: "#F44336",
      inactive: "#9E9E9E",
    },
    defaultColor: "#4CAF50",
    inactiveOpacity: 0.5,
    iconPath:
      "M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2M5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5S3.07 13.5 5 13.5s3.5 1.57 3.5 3.5S6.93 20.5 5 20.5m5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V11c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 10.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 16v5h2v-6.2zm9.2 1.5c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5",
  },
  showResultsList: true,
  placeCategory: "Bike Sharing Station",
  placeCategoryRaw: "bicycle_rental",
};

class BikeSharingProvider implements DataSourceProvider {
  readonly id = "bike-sharing";
  readonly meta = META;
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;

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

    // Fetch from all sources in parallel
    const [nextbikeResult, cityBikesResult, donkeyResult, gbfsResult, dbBikeResult, motisResult] =
      await Promise.allSettled([
        searchNextbike(bbox),
        searchCityBikes(bbox),
        searchDonkey(bbox),
        fetchGbfsData(bbox, BIKE_FORM_FACTORS),
        searchDbBikes(bbox),
        fetchMotisRentals(bboxArray, ["bicycle", "cargo_bicycle"]),
      ]);

    const allStations: SharedMobilityStation[] = [];
    const results: DataSourceResult[] = [];

    // Nextbike first (best coverage, 300+ cities)
    if (nextbikeResult.status === "fulfilled") {
      allStations.push(...nextbikeResult.value);
    }

    // CityBikes second
    if (cityBikesResult.status === "fulfilled") {
      allStations.push(...cityBikesResult.value);
    }

    // Donkey Republic third
    if (donkeyResult.status === "fulfilled") {
      allStations.push(...donkeyResult.value);
    }

    // GBFS stations
    if (gbfsResult.status === "fulfilled") {
      allStations.push(...gbfsResult.value.stations);
    }

    // DB Call-a-Bike / StadtRad stations
    if (dbBikeResult.status === "fulfilled") {
      allStations.push(...dbBikeResult.value.stations);
    }

    // MOTIS/Transitous stations (appended last so existing sources take dedup priority)
    if (motisResult.status === "fulfilled") {
      allStations.push(...motisResult.value.stations);
    }

    // Dedup and map stations
    const deduped = dedupStations(allStations);
    for (const s of deduped) {
      updateCache(s.id, s);
      results.push(mapStationToResult(s));
    }

    // DB free-floating bikes
    if (dbBikeResult.status === "fulfilled") {
      for (const v of dbBikeResult.value.vehicles) {
        updateCache(v.id, v);
        results.push(mapVehicleToResult(v));
      }
    }

    // MOTIS/Transitous free-floating bikes
    if (motisResult.status === "fulfilled") {
      for (const v of motisResult.value.vehicles) {
        updateCache(v.id, v);
        results.push(mapVehicleToResult(v));
      }
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
}

export const bikeSharingProvider = new BikeSharingProvider();
