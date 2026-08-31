/**
 * Car Sharing data source provider.
 * Combines GBFS car feeds + registered regional car-sharing clients.
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
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import { buildSharedMobilityMapContext } from "@openmapx/mobility-core/shared-mobility-context";
import { orchestrateSharedMobility } from "@openmapx/mobility-core/shared-mobility-orchestrator";
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

const CAR_FORM_FACTORS = new Set<VehicleFormFactor>(["car"]);

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
    const inventory = await orchestrateSharedMobility(bbox, {
      category: "car",
      formFactors: CAR_FORM_FACTORS,
      motisFormFactors: ["car"],
      adapters: [
        {
          id: "direct-gbfs",
          kind: "fallback",
          fetch: (bounds) => fetchGbfsData(bounds, CAR_FORM_FACTORS),
        },
        {
          id: "swiss-gbfs",
          kind: "fallback",
          fetch: (bounds) => fetchSwissSharedMobilityDataForBbox(bounds, CAR_FORM_FACTORS),
        },
        {
          id: "regional",
          kind: "proprietary",
          fetch: async (bounds) => ({
            stations: mergeRegionalStations(await searchRegionalClients(bounds)),
            vehicles: [],
          }),
        },
      ],
    });

    try {
      await enrichEnturMobilityItems(inventory.stations, inventory.vehicles, { scope: "map" });
    } catch (error) {
      console.warn("[car-sharing] Entur enrichment failed", error);
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
      await buildSharedMobilityMapContext(bbox, CAR_FORM_FACTORS, options),
      attribution.all(),
    );
  }
}

export const carSharingProvider = new CarSharingProvider();
