import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import {
  createManifestAttribution,
  isInColdStart,
  type Logger,
  type MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { deduplicateChargingStations, haversineMeters } from "./dedup.js";
import { getEvChargingFilters } from "./reference.js";
import { EV_CHARGING_SOURCE_REGISTRY } from "./registry.js";
import { mapStationToDetail, mapStationToResult } from "./station-mapper.js";

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

// Resolve a source id to its human-readable name from the manifest's
// dataSources (e.g. "ocm" → "OpenChargeMap"), falling back to the raw id.
const resolveSourceName = (id: string): string => attribution.bySource(id)?.name ?? id;

// PoiReader-backed sources whose cold-start state should flip
// `freshness.isStale=true` on the wrapped result. Hardcoded (rather than
// derived from `declarePoiSources()`) to avoid a circular import with
// poi-sources.ts; the list is small and rarely changes.
const POI_READER_BACKED_EV_SOURCES = ["de-bnetza", "ch-sfoe"] as const;

function anyEvSourceColdStart(): boolean {
  return POI_READER_BACKED_EV_SOURCES.some((id) => isInColdStart(id));
}

const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(
    data,
    attributions,
    freshnessNow({ hasRealtimeData: false, isStale: anyEvSourceColdStart() }),
  );

const wrapDetail = <T>(
  data: T,
  attributions: Attribution[],
  hasRealtimeData: boolean,
): MobilityResult<T> =>
  withAttribution(
    data,
    attributions,
    freshnessNow({ hasRealtimeData, isStale: anyEvSourceColdStart() }),
  );

function attributionsForStation(station: EvChargingStation): Attribution[] {
  return attribution.forResults([station], (s) => s.sources);
}

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
  get attribution(): Attribution[] {
    return attribution.all();
  }

  private log: Logger | null = null;

  setLogger(logger: Logger): void {
    this.log = logger;
  }

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

    let rejectedCount = 0;
    const allStations = results.flatMap((result, i) => {
      if (result.status === "fulfilled") return result.value;
      rejectedCount++;
      this.log?.warn(
        `ev-charging source ${EV_CHARGING_SOURCE_REGISTRY[i].id} failed`,
        result.reason,
      );
      return [];
    });
    if (rejectedCount > 0 && rejectedCount === results.length) {
      this.log?.error("all ev-charging sources failed");
    }
    const merged = deduplicateChargingStations(allStations);
    for (const station of merged) this.cacheStation(station);
    const mapped = merged.map(mapStationToResult);
    const anyLive = merged.some((s) => s.isLive);
    return withAttribution(
      mapped,
      attribution.forResults(mapped, (r) => r.sources ?? r.source),
      freshnessNow({ hasRealtimeData: anyLive, isStale: anyEvSourceColdStart() }),
    );
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const cached = this.stationCache.get(itemId);
    if (cached) {
      return wrapDetail(
        mapStationToDetail(cached, resolveSourceName),
        attributionsForStation(cached),
        Boolean(cached.isLive),
      );
    }

    const primary = await this.fetchByPrefix(itemId);
    if (!primary) return wrapStatic(null, []);

    const enriched = await this.enrichStation(primary);
    this.cacheStation(enriched);
    return wrapDetail(
      mapStationToDetail(enriched, resolveSourceName),
      attributionsForStation(enriched),
      Boolean(enriched.isLive),
    );
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
    const nearby = results.flatMap((result, i) => {
      if (result.status === "fulfilled") return result.value;
      this.log?.warn(
        `ev-charging source ${EV_CHARGING_SOURCE_REGISTRY[i].id} failed`,
        result.reason,
      );
      return [];
    });
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

export function setLogger(logger: Logger): void {
  evChargingProvider.setLogger(logger);
}
