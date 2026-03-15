/**
 * Scooter Sharing data source provider.
 * Combines GBFS scooter feeds + Felyx + GO Sharing + Link.
 * Handles both free-floating vehicles and docked stations.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { DataSourceProvider } from "../types.js";
import { dedupStations } from "./dedup.js";
import { searchFelyx } from "./felyx-client.js";
import { fetchGbfsData } from "./gbfs-provider-base.js";
import { searchGoSharing } from "./gosharing-client.js";
import { searchLink } from "./link-client.js";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "./mapper.js";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

// In-memory cache for detail lookups
const itemCache = new Map<string, SharedMobilityStation | SharedMobilityVehicle>();
const MAX_CACHE_SIZE = 5000;

const META: DataSourceMeta = {
  id: "scooter-sharing",
  name: "E-Scooters",
  attribution: [
    { text: "GBFS", url: "https://gbfs.org" },
    { text: "Felyx", url: "https://felyx.com" },
    { text: "GO Sharing", url: "https://go-sharing.com", license: "Proprietary" },
    { text: "Link", url: "https://www.link.city" },
  ],
  categoryChipLabel: "E-Scooters",
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
  "moped",
]);

class ScooterSharingProvider implements DataSourceProvider {
  readonly id = META.id;
  readonly meta = META;
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return [];
  }

  async search(bbox: BoundingBox): Promise<DataSourceResult[]> {
    // Fetch from all sources in parallel
    const [gbfsResult, felyxResult, goSharingResult, linkResult] = await Promise.allSettled([
      fetchGbfsData(bbox, SCOOTER_FORM_FACTORS, "other"),
      searchFelyx(bbox),
      searchGoSharing(bbox),
      searchLink(bbox),
    ]);

    const results: DataSourceResult[] = [];

    // Log results for debugging
    for (const [name, result] of [
      ["GBFS", gbfsResult],
      ["Felyx", felyxResult],
      ["GO Sharing", goSharingResult],
      ["Link", linkResult],
    ] as const) {
      if (result.status === "rejected") {
        console.warn(`[scooter-sharing] ${name} failed:`, result.reason);
      } else {
        const count =
          "stations" in result.value
            ? (result.value as { stations: unknown[]; vehicles: unknown[] }).stations.length +
              (result.value as { stations: unknown[]; vehicles: unknown[] }).vehicles.length
            : (result.value as unknown[]).length;
        console.log(`[scooter-sharing] ${name}: ${count} results`);
      }
    }

    // GBFS stations
    if (gbfsResult.status === "fulfilled") {
      const deduped = dedupStations(gbfsResult.value.stations);
      for (const station of deduped) {
        updateCache(station.id, station);
        results.push(mapStationToResult(station));
      }
      for (const vehicle of gbfsResult.value.vehicles) {
        updateCache(vehicle.id, vehicle);
        results.push(mapVehicleToResult(vehicle));
      }
    }

    // Felyx mopeds
    if (felyxResult.status === "fulfilled") {
      for (const vehicle of felyxResult.value) {
        updateCache(vehicle.id, vehicle);
        results.push(mapVehicleToResult(vehicle));
      }
    }

    // GO Sharing scooters
    if (goSharingResult.status === "fulfilled") {
      for (const vehicle of goSharingResult.value) {
        updateCache(vehicle.id, vehicle);
        results.push(mapVehicleToResult(vehicle));
      }
    }

    // Link e-scooters
    if (linkResult.status === "fulfilled") {
      for (const vehicle of linkResult.value) {
        updateCache(vehicle.id, vehicle);
        results.push(mapVehicleToResult(vehicle));
      }
    }

    return results;
  }

  async getDetail(itemId: string): Promise<DataSourceDetail> {
    const cached = itemCache.get(itemId);
    if (cached) {
      if ("availableVehicles" in cached) return mapStationToDetail(cached);
      return mapVehicleToDetail(cached);
    }

    return {
      id: itemId,
      source: "scooter-sharing",
      name: "E-Scooter",
      coordinates: [0, 0],
      attribution: { text: "GBFS", url: "https://gbfs.org" },
      sections: [],
    };
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
