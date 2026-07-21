/**
 * Scooter Sharing data source provider.
 * Combines GBFS scooter feeds + Felyx + NRW Mobidrom + MOTIS/Transitous.
 * Handles both free-floating vehicles and docked stations.
 */

import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
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
import { searchDeNwMobidromScooter } from "./de-nw-mobidrom-scooter-client.js";
import { searchFelyx } from "./felyx-client.js";

const detailStore = new SharedMobilityDetailStore(600, 5_000);
export const setDetailCache = (cache: CacheClient): void => detailStore.setCache(cache);

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

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

const wrapRT = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: true }));
const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

class ScooterSharingProvider implements MobilityDataSourceProvider {
  readonly id = "scooter-sharing";
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
      category: "scooter",
      formFactors: SCOOTER_FORM_FACTORS,
      motisFormFactors: ["scooter_standing", "scooter_seated", "moped"],
      adapters: [
        {
          id: "direct-gbfs",
          kind: "fallback",
          fetch: (bounds) => fetchGbfsData(bounds, SCOOTER_FORM_FACTORS, "other"),
        },
        {
          id: "swiss-gbfs",
          kind: "fallback",
          fetch: (bounds) =>
            fetchSwissSharedMobilityDataForBbox(bounds, SCOOTER_FORM_FACTORS, "other"),
        },
        {
          id: "felyx",
          kind: "proprietary",
          fetch: async (bounds) => ({ stations: [], vehicles: await searchFelyx(bounds) }),
        },
        {
          id: "nrw-mobidrom",
          kind: "proprietary",
          fetch: searchDeNwMobidromScooter,
        },
      ],
    });

    try {
      await enrichEnturMobilityItems(inventory.stations, inventory.vehicles, { scope: "map" });
    } catch (error) {
      console.warn("[scooter-sharing] Entur enrichment failed", error);
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
      await buildSharedMobilityMapContext(bbox, SCOOTER_FORM_FACTORS, options),
      attribution.all(),
    );
  }
}

export const scooterSharingProvider = new ScooterSharingProvider();
