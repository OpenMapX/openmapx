import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
  withContributors,
} from "@openmapx/mobility-core/contributors";
import {
  type SharedMobilityDetailItem,
  SharedMobilityDetailStore,
} from "@openmapx/mobility-core/detail-store";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import type { VehicleFormFactor } from "@openmapx/mobility-core/shared-mobility";
import type { SharedMobilityInventory } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import type { SharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import type { CacheClient } from "./context";
import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider";
import { createManifestAttribution, type IntegrationDataSource } from "./manifest";
import { buildSharedMobilityMapContext } from "./shared-mobility/context";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
  stripMobilityKindPrefix,
} from "./shared-mobility/mapper";

/** Capture the explicit acquisition owner's canonical declared sources. */
export function createSharedMobilityContributorResolver(dataSources: IntegrationDataSource[]) {
  const attribution = createManifestAttribution();
  attribution.set(dataSources);
  return (sourceIds: readonly string[]) =>
    snapshotContributors(attribution.forResults([...sourceIds], (id) => id));
}

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
  cache: CacheClient;
  dataSources: IntegrationDataSource[];
  runtime: SharedMobilityRuntime;
  loadInventory(bbox: BoundingBox): Promise<SharedMobilityInventory>;
}

export function createSharedMobilityProvider(
  config: SharedMobilityProviderConfig,
): MobilityDataSourceProvider {
  const attribution = createManifestAttribution();
  attribution.set(config.dataSources);
  const detailStore = new SharedMobilityDetailStore(
    config.cache,
    config.detailStore.ttlSeconds,
    config.detailStore.maxL1Items,
    config.detailStore.maxSnapshotItems,
  );
  const wrapRealtime = <T>(
    data: T,
    attributions: Attribution[],
    acquiredAt?: number,
  ): MobilityResult<T> =>
    withAttribution(data, attributions, {
      ...freshnessNow({ hasRealtimeData: true }),
      ...(acquiredAt === undefined ? {} : { fetchedAt: new Date(acquiredAt).toISOString() }),
    });
  const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
    withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

  const captureItem = <T extends SharedMobilityDetailItem>(item: T) =>
    withContributors(
      item,
      item.contributors ?? attribution.forResults([item], (record) => record.sources),
    );

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
        await config.runtime.enrichEnturMobilityItems(
          inventory.stations,
          inventory.vehicles,
          "map",
          (ids) => attribution.forResults([...ids], (id) => id),
        );
      } catch (error) {
        console.warn(`[${config.id}] Entur enrichment failed`, error);
      }

      // Capture the provider generation's metadata before detail caching or mapping.
      const stations = inventory.stations.map((item) => captureItem(item));
      const vehicles = inventory.vehicles.map((item) => captureItem(item));
      await detailStore.store([...stations, ...vehicles]);
      const results = [
        ...stations.map((station) => mapStationToResult(station)),
        ...vehicles.map((vehicle) => mapVehicleToResult(vehicle)),
      ];
      return wrapRealtime(results, contributorsForRecords(results));
    },
    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const retained = await detailStore.getRetained(stripMobilityKindPrefix(itemId));
      if (!retained) return wrapRealtime(null, []);
      const cached = structuredClone(retained.item);

      const isStation = "availableVehicles" in cached;
      await config.runtime
        .enrichEnturMobilityItems(
          isStation ? [cached] : [],
          isStation ? [] : [cached],
          "detail",
          (ids) => attribution.forResults([...ids], (id) => id),
        )
        .catch(() => undefined);
      const captured = captureItem(cached);
      // Preserve the inventory's original deadline; enrichment cannot renew availability.
      await detailStore.updateRetained(retained, captured);
      if (retained.expiresAt <= Date.now()) return wrapRealtime(null, []);
      return wrapRealtime(
        "availableVehicles" in captured
          ? mapStationToDetail(captured)
          : mapVehicleToDetail(captured),
        captured.contributors,
        retained.acquiredAt,
      );
    },
    async getMapContext(
      bbox: BoundingBox,
      _filters?: Record<string, unknown>,
      options?: DataSourceMapContextSelection,
    ) {
      const context = await buildSharedMobilityMapContext(
        bbox,
        config.formFactors,
        config.runtime,
        options,
        (ids) => attribution.forResults([...ids], (id) => id),
      );
      return wrapStatic(
        context,
        snapshotContributors(
          ...(context?.geojson.features ?? []).map(
            (feature) => parseContributors(feature.properties?._mapAttributions) ?? [],
          ),
        ),
      );
    },
  };

  return provider;
}
