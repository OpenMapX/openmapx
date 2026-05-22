import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import type { MobilityDataSourceProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { deduplicateChargingStations, haversineMeters } from "./dedup.js";
import { getEvChargingFilters } from "./reference.js";
import { EV_CHARGING_SOURCE_REGISTRY } from "./registry.js";
import { mapStationToDetail, mapStationToResult } from "./station-mapper.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "ocm",
    name: "OpenChargeMap",
    url: "https://openchargemap.org/",
    spdxLicense: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
];

const wrapStatic = <T>(data: T): MobilityResult<T> =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: false }));

const META: DataSourceMeta = {
  minZoom: 8,
  placeCategory: "Charging Station",
  placeCategoryRaw: "charging_station",
  osmFilters: CATEGORY_FILTERS.ev_charging,
  markerStyle: {
    variantColors: {
      slow: "#4CAF50",
      fast: "#FF9800",
      "ultra-rapid": "#F44336",
      unknown: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath: "M7 2v11h3v9l7-12h-4l4-8H7z",
  },
};

class EvChargingProvider implements MobilityDataSourceProvider {
  readonly id = "ev-charging";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 60;
  readonly detailCacheTtl = 60;
  readonly attribution = ATTRIBUTION;

  private stationCache = new Map<string, EvChargingStation>();

  private cacheStation(station: EvChargingStation): void {
    const keys = [station.id, ...(station.sourceItemIds ?? [])];
    for (const key of keys) {
      if (this.stationCache.size >= 5000) {
        const firstKey = this.stationCache.keys().next().value;
        if (firstKey !== undefined) this.stationCache.delete(firstKey);
      }
      this.stationCache.set(key, station);
    }
  }

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return getEvChargingFilters();
  }

  async search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>> {
    const results = await Promise.allSettled(
      EV_CHARGING_SOURCE_REGISTRY.map((source) => source.search(bbox, filters)),
    );

    const allStations = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const merged = deduplicateChargingStations(allStations);
    for (const station of merged) this.cacheStation(station);
    return wrapStatic(merged.map(mapStationToResult));
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const cached = this.stationCache.get(itemId);
    if (cached) return wrapStatic(mapStationToDetail(cached));

    const primary = await this.fetchByPrefix(itemId);
    if (!primary) return wrapStatic(null);

    const enriched = await this.enrichStation(primary);
    this.cacheStation(enriched);
    return wrapStatic(mapStationToDetail(enriched));
  }

  private async fetchByPrefix(itemId: string): Promise<EvChargingStation | null> {
    for (const source of EV_CHARGING_SOURCE_REGISTRY) {
      if (!source.canFetchDetail?.(itemId) || !source.fetchDetail) continue;
      const station = await source.fetchDetail(itemId);
      if (station) return station;
    }
    return null;
  }

  private async enrichStation(station: EvChargingStation): Promise<EvChargingStation> {
    const [lng, lat] = station.coordinates;
    const margin = 0.002;
    const bbox: BoundingBox = {
      south: lat - margin,
      west: lng - margin,
      north: lat + margin,
      east: lng + margin,
    };

    const results = await Promise.allSettled(
      EV_CHARGING_SOURCE_REGISTRY.map((source) => source.search(bbox)),
    );
    const nearby = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const merged = deduplicateChargingStations([station, ...nearby]);
    const ids = new Set([station.id, ...(station.sourceItemIds ?? [])]);

    return (
      merged.find((candidate) =>
        [candidate.id, ...(candidate.sourceItemIds ?? [])].some((id) => ids.has(id)),
      ) ??
      merged.find(
        (candidate) => haversineMeters(candidate.coordinates, station.coordinates) <= 150,
      ) ??
      station
    );
  }
}

export const evChargingProvider = new EvChargingProvider();
