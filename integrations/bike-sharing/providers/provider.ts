/**
 * Bike Sharing data source provider.
 * Combines CityBikes API + GBFS bicycle feeds + Nextbike + Donkey Republic.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContextSelection,
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
import { SharedMobilityDetailStore } from "@openmapx/mobility-core/detail-store";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
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
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { buildSharedMobilityMapContext } from "@openmapx/mobility-core/shared-mobility-context";
import { orchestrateSharedMobility } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import { searchCityBikes } from "./citybikes-client.js";
import { searchDbBikes } from "./db-bike-client.js";
import { searchDonkey } from "./donkey-client.js";
import { searchNextbike } from "./nextbike-client.js";

const BIKE_FORM_FACTORS = new Set<
  import("@openmapx/mobility-core/shared-mobility").VehicleFormFactor
>(["bicycle", "cargo_bicycle"]);

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

const wrapRT = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: true }));
const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

const detailStore = new SharedMobilityDetailStore(600, 5_000);
export const setDetailCache = (cache: CacheClient): void => detailStore.setCache(cache);

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
  osmFilters: CATEGORY_FILTERS.bicycle_rental,
};

class BikeSharingProvider implements MobilityDataSourceProvider {
  readonly id = "bike-sharing";
  readonly meta = META;
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;
  readonly mapContextCacheTtl = 300;
  get attribution(): Attribution[] {
    return attribution.all();
  }

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return [];
  }

  async search(bbox: BoundingBox): Promise<MobilityResult<DataSourceResult[]>> {
    const inventory = await orchestrateSharedMobility(bbox, {
      category: "bike",
      formFactors: BIKE_FORM_FACTORS,
      motisFormFactors: ["bicycle", "cargo_bicycle"],
      adapters: [
        {
          id: "nextbike",
          kind: "fallback",
          fetch: async (bounds) => ({ stations: await searchNextbike(bounds), vehicles: [] }),
        },
        {
          id: "citybikes",
          kind: "fallback",
          fetch: async (bounds) => ({ stations: await searchCityBikes(bounds), vehicles: [] }),
        },
        {
          id: "donkey",
          kind: "fallback",
          fetch: async (bounds) => ({ stations: await searchDonkey(bounds), vehicles: [] }),
        },
        {
          id: "direct-gbfs",
          kind: "fallback",
          fetch: (bounds) => fetchGbfsData(bounds, BIKE_FORM_FACTORS),
        },
        {
          id: "swiss-gbfs",
          kind: "fallback",
          fetch: (bounds) => fetchSwissSharedMobilityDataForBbox(bounds, BIKE_FORM_FACTORS),
        },
        {
          id: "db-bike",
          kind: "proprietary",
          fetch: searchDbBikes,
        },
      ],
    });

    try {
      await enrichEnturMobilityItems(inventory.stations, inventory.vehicles, { scope: "map" });
    } catch (error) {
      console.warn("[bike-sharing] Entur enrichment failed", error);
    }

    await detailStore.store([...inventory.stations, ...inventory.vehicles]);
    const results = [
      ...inventory.stations.map((station) => mapStationToResult(station)),
      ...inventory.vehicles.map((vehicle) => mapVehicleToResult(vehicle)),
    ];
    return wrapRT(
      results,
      attribution.forResults(results, (result) => result.sources ?? result.source),
    );
  }
  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const cached = await detailStore.get(stripMobilityKindPrefix(itemId));
    if (cached) {
      await enrichEnturMobilityItems(
        "availableVehicles" in cached ? [cached] : [],
        "availableVehicles" in cached ? [] : [cached],
        { scope: "detail" },
      ).catch(() => undefined);
      const attrs = attribution.forResults([cached], (c) => c.sources);
      if ("availableVehicles" in cached) return wrapRT(mapStationToDetail(cached), attrs);
      return wrapRT(mapVehicleToDetail(cached), attrs);
    }

    return wrapRT(null, []);
  }

  async getMapContext(
    bbox: BoundingBox,
    _filters?: Record<string, unknown>,
    options?: DataSourceMapContextSelection,
  ) {
    return wrapStatic(
      await buildSharedMobilityMapContext(bbox, BIKE_FORM_FACTORS, options),
      attribution.all(),
    );
  }
}

export const bikeSharingProvider = new BikeSharingProvider();
