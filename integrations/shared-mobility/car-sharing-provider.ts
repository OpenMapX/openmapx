/**
 * Car Sharing data source provider.
 * Combines GBFS car feeds + registered regional car-sharing clients.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DomainDataSourceProvider as DataSourceProvider,
  DataSourceResult,
} from "@openmapx/core";
import { searchRegionalClients } from "./car-sharing-registry.js";
import { dedupStations } from "./dedup.js";
import { fetchGbfsData } from "./gbfs-provider-base.js";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "./mapper.js";
import { mergeRegionalStations } from "./merge-stations.js";
import { fetchMotisRentals } from "./motis-rentals.js";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

// In-memory cache for detail lookups
const itemCache = new Map<string, SharedMobilityStation | SharedMobilityVehicle>();
const MAX_CACHE_SIZE = 3000;

const META: DataSourceMeta = {
  id: "car-sharing",
  name: "Car Sharing",
  attribution: [
    { text: "GBFS", url: "https://gbfs.org" },
    {
      text: "Cambio",
      url: "https://www.cambio-carsharing.de",
      license: "ODbL",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    },
    {
      text: "Stadtteilauto Münster",
      url: "https://opendata.stadt-muenster.de",
      license: "dl-de/by-2-0",
      licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
    },
    {
      text: "Stadt Wuppertal",
      url: "https://www.offenedaten-wuppertal.de",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    {
      text: "Stadt Bielefeld",
      url: "https://open-data.bielefeld.de",
      license: "ODbL",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    },
  ],
  categoryChipLabel: "Car Sharing",
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
};

const CAR_FORM_FACTORS = new Set<import("./types.js").VehicleFormFactor>(["car"]);

class CarSharingProvider implements DataSourceProvider {
  readonly id = META.id;
  readonly meta = META;
  readonly searchCacheTtl = 300;
  readonly detailCacheTtl = 300;

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
    const [regionalResult, gbfsResult, motisResult] = await Promise.allSettled([
      searchRegionalClients(bbox),
      fetchGbfsData(bbox, CAR_FORM_FACTORS),
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

    // MOTIS/Transitous stations (appended last so existing sources take dedup priority)
    if (motisResult.status === "fulfilled") {
      allStations.push(...motisResult.value.stations);
    }

    // Dedup and map GBFS + MOTIS stations
    const deduped = dedupStations(allStations);
    for (const station of deduped) {
      updateCache(station.id, station);
      results.push(mapStationToResult(station));
    }

    // GBFS free-floating vehicles
    if (gbfsResult.status === "fulfilled") {
      for (const vehicle of gbfsResult.value.vehicles) {
        updateCache(vehicle.id, vehicle);
        results.push(mapVehicleToResult(vehicle));
      }
    }

    // MOTIS/Transitous free-floating cars
    if (motisResult.status === "fulfilled") {
      for (const vehicle of motisResult.value.vehicles) {
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
      source: "car-sharing",
      name: "Car Sharing Station",
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

export const carSharingProvider = new CarSharingProvider();
