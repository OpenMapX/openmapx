import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
} from "@openmapx/core";
import {
  type DataSourceSearchResult,
  type IntegrationContext,
  type MobilityDataSourceProvider,
  selectedOptions,
  siteAttributions,
  toBBox,
  withinZoom,
  wrapSiteResult,
} from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import { mapStationToDetail, mapStationToResult, variantOf } from "./mapper.js";
import { createRoadWeatherOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 8,
  showResultsList: true,
  placeCategory: "Road weather station",
  placeCategoryRaw: "road-weather-station",
  markerStyle: {
    variantColors: {
      dry: "#4CAF50",
      wet: "#2196F3",
      snowy: "#9C27B0",
      icy: "#F44336",
      unknown: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath:
      "M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4m-4-2V5c0-.55.45-1 1-1s1 .45 1 1v1h-1v1h1v2h-1v1h1v1z",
  },
};

/** What lies on the road, which are also the marker variants. */
const SURFACE_OPTIONS = [
  { id: "dry", label: "Dry" },
  { id: "wet", label: "Wet" },
  { id: "snowy", label: "Snow or slush" },
  { id: "icy", label: "Ice or frost" },
];

const STATION_FILTERS: DataSourceFilterDef[] = [
  { id: "surface", label: "Road surface", type: "multi-select", options: SURFACE_OPTIONS },
];

/** Seconds a search answer is cached: stations report every few minutes. */
const SEARCH_CACHE_TTL_S = 120;
/** Seconds a station's detail is cached. */
const DETAIL_CACHE_TTL_S = 60;

/**
 * The `road-weather` data source: every registered road-weather provider
 * merged behind one search and one detail. The surface filter (dry, wet,
 * snow or slush, ice or frost) is applied here. It is listed only while a
 * provider is registered, and a search some provider answered only in part
 * is marked partial with the reason, so the host does not cache it.
 */
export function createRoadWeatherDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const stations = createRoadWeatherOrchestrator(ctx);
  return {
    id: "road-weather",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => stations.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return STATION_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const surfaces = selectedOptions(filters, "surface");
      const found = await stations.search(toBBox(bbox));
      const kept =
        surfaces.size > 0 ? found.sites.filter((s) => surfaces.has(variantOf(s))) : found.sites;
      const result = wrapSiteResult(kept.map(mapStationToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const station = await stations.find(itemId);
      if (!station) return wrapSiteResult(null, []);
      return wrapSiteResult(mapStationToDetail(station), station.attributions);
    },
  };
}
