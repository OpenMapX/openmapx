import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { SharedMobilityDetailStore } from "@openmapx/mobility-core/detail-store";
import { enrichEnturMobilityItems } from "@openmapx/mobility-core/entur-mobility";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
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
import type { SharedMobilityInventory } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import type { CacheClient } from "./context";
import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider";
import { createManifestAttribution, type IntegrationDataSource } from "./manifest";

export interface SharedMobilityProviderConfig {
  id: string;
  meta: DataSourceMeta;
  formFactors: ReadonlySet<VehicleFormFactor>;
  searchCacheTtl: number;
  detailCacheTtl: number;
  mapContextCacheTtl: number;
  detailStore: {
    ttlSeconds: number;
    maxL1Items: number;
    maxSnapshotItems?: number;
  };
  loadInventory(bbox: BoundingBox): Promise<SharedMobilityInventory>;
}

export interface SharedMobilityProviderDefinition {
  provider: MobilityDataSourceProvider;
  setDetailCache(cache: CacheClient): void;
  setManifestDataSources(dataSources: IntegrationDataSource[]): void;
}

export function createSharedMobilityProvider(
  config: SharedMobilityProviderConfig,
): SharedMobilityProviderDefinition {
  const attribution = createManifestAttribution();
  const detailStore = new SharedMobilityDetailStore(
    config.detailStore.ttlSeconds,
    config.detailStore.maxL1Items,
    config.detailStore.maxSnapshotItems,
  );
  const wrapRealtime = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
    withAttribution(data, attributions, freshnessNow({ hasRealtimeData: true }));
  const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
    withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

  const provider: MobilityDataSourceProvider = {
    id: config.id,
    meta: config.meta,
    searchCacheTtl: config.searchCacheTtl,
    detailCacheTtl: config.detailCacheTtl,
    mapContextCacheTtl: config.mapContextCacheTtl,
    get attribution() {
      return attribution.all();
    },
    async getFilters() {
      return [];
    },
    async search(bbox: BoundingBox): Promise<MobilityResult<DataSourceResult[]>> {
      const inventory = await config.loadInventory(bbox);

      try {
        await enrichEnturMobilityItems(inventory.stations, inventory.vehicles, { scope: "map" });
      } catch (error) {
        console.warn(`[${config.id}] Entur enrichment failed`, error);
      }

      await detailStore.store([...inventory.stations, ...inventory.vehicles]);
      const results = [
        ...inventory.stations.map((station) => mapStationToResult(station)),
        ...inventory.vehicles.map((vehicle) => mapVehicleToResult(vehicle)),
      ];
      return wrapRealtime(
        results,
        attribution.forResults(results, (result) => result.sources ?? result.source),
      );
    },
    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const cached = await detailStore.get(stripMobilityKindPrefix(itemId));
      if (!cached) return wrapRealtime(null, []);

      const isStation = "availableVehicles" in cached;
      await enrichEnturMobilityItems(isStation ? [cached] : [], isStation ? [] : [cached], {
        scope: "detail",
      }).catch(() => undefined);
      const attributions = attribution.forResults([cached], (item) => item.sources);
      return wrapRealtime(
        isStation ? mapStationToDetail(cached) : mapVehicleToDetail(cached),
        attributions,
      );
    },
    async getMapContext(
      bbox: BoundingBox,
      _filters?: Record<string, unknown>,
      options?: DataSourceMapContextSelection,
    ) {
      return wrapStatic(
        await buildSharedMobilityMapContext(bbox, config.formFactors, options),
        attribution.all(),
      );
    },
  };

  return {
    provider,
    setDetailCache(cache) {
      detailStore.setCache(cache);
    },
    setManifestDataSources(dataSources) {
      attribution.set(dataSources);
    },
  };
}
