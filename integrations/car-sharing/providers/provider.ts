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
import {
  type CacheClient,
  createManifestAttribution,
  type MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { dedupStations, dedupVehicles } from "@openmapx/mobility-core/dedup";
import { SharedMobilityDetailStore } from "@openmapx/mobility-core/detail-store";
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
  stripMobilityKindPrefix,
} from "@openmapx/mobility-core/mapper";
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
} from "@openmapx/mobility-core/shared-mobility";
import { mergeRegionalStations } from "./merge-stations.js";
import { searchRegionalClients } from "./registry.js";

const detailStore = new SharedMobilityDetailStore(900, 3_000);
export const setDetailCache = (cache: CacheClient): void => detailStore.setCache(cache);

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

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

const wrapRT = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: true }));
const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

class CarSharingProvider implements MobilityDataSourceProvider {
  readonly id = "car-sharing";
  readonly meta = META;
  readonly searchCacheTtl = 300;
  readonly detailCacheTtl = 300;
  readonly mapContextCacheTtl = 300;
  get attribution(): Attribution[] {
    return attribution.all();
  }

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

    // Fetch from registered regional clients and GBFS in parallel
    const [regionalResult, gbfsResult, swissGbfsResult, motisResult] = await Promise.allSettled([
      searchRegionalClients(bbox),
      fetchGbfsData(bbox, CAR_FORM_FACTORS),
      fetchSwissSharedMobilityDataForBbox(bbox, CAR_FORM_FACTORS),
      fetchMotisRentals(bboxArray, ["car"]),
    ]);

    const allStations: SharedMobilityStation[] = [];
    const regionalStations: SharedMobilityStation[] = [];
    const results: DataSourceResult[] = [];

    // Regional clients first (known reliable sources, higher priority for dedup).
    // mergeRegionalStations keeps the first occurrence's live availability data
    // but enriches it with extra fields (address, website, description) from
    // later occurrences at the same coordinates.
    if (regionalResult.status === "fulfilled") {
      const merged = mergeRegionalStations(regionalResult.value);
      regionalStations.push(...merged);
      for (const station of merged) {
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

    await detailStore.store([
      ...regionalStations,
      ...dedupedStations,
      ...dedupedVehicles,
      ...(motisResult.status === "fulfilled"
        ? [...motisResult.value.stations, ...motisResult.value.vehicles]
        : []),
    ]);

    for (const station of dedupedStations) {
      results.push(mapStationToResult(station));
    }

    for (const vehicle of dedupedVehicles) {
      results.push(mapVehicleToResult(vehicle));
    }

    return wrapRT(
      results,
      attribution.forResults(results, (r) => r.sources ?? r.source),
    );
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const cached = await detailStore.get(stripMobilityKindPrefix(itemId));
    if (cached) {
      const attrs = attribution.forResults([cached], (c) => c.sources);
      if ("availableVehicles" in cached) return wrapRT(mapStationToDetail(cached), attrs);
      return wrapRT(mapVehicleToDetail(cached), attrs);
    }

    return wrapRT(null, []);
  }

  async getMapContext(
    bbox: BoundingBox,
    _filters?: Record<string, unknown>,
    options?: { systemIds?: string[]; vehicleTypeIds?: string[] },
  ) {
    return wrapStatic(await buildEnturGeofencingMapContext(bbox, options), attribution.all());
  }
}

export const carSharingProvider = new CarSharingProvider();
