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
import { mapCrossingToDetail, mapCrossingToResult, variantOf } from "./mapper.js";
import { createBorderCrossingOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 6,
  showResultsList: true,
  placeCategory: "Border crossing",
  placeCategoryRaw: "border-crossing",
  markerStyle: {
    variantColors: {
      short: "#4CAF50",
      moderate: "#FF9800",
      long: "#F44336",
      closed: "#9E9E9E",
      unknown: "#2196F3",
    },
    defaultColor: "#2196F3",
    inactiveOpacity: 0.4,
    iconPath:
      "M9 1h6v2H9zm10.03 6.39 1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42C16.07 4.74 14.12 4 12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61M13 14h-2V8h2z",
  },
};

/** How long the cars queue, which are also the marker variants. */
const WAIT_OPTIONS = [
  { id: "short", label: "Up to 15 min" },
  { id: "moderate", label: "15 to 45 min" },
  { id: "long", label: "Over 45 min" },
  { id: "closed", label: "Closed" },
];

const CROSSING_FILTERS: DataSourceFilterDef[] = [
  { id: "wait", label: "Wait time", type: "multi-select", options: WAIT_OPTIONS },
];

/** Seconds a search answer is cached: the agencies restate their waits every 10 to 15 minutes. */
const SEARCH_CACHE_TTL_S = 120;
/** Seconds a crossing's detail is cached. */
const DETAIL_CACHE_TTL_S = 60;

/**
 * The `border-crossings` data source: every registered border-crossing
 * provider merged behind one search and one detail. The wait filter (up to
 * 15 minutes, 15 to 45, over 45, closed) is applied here. It is listed only
 * while a provider is registered, and a search some provider answered only
 * in part is marked partial with the reason, so the host does not cache it.
 */
export function createBorderCrossingDataSource(
  ctx: IntegrationContext,
): MobilityDataSourceProvider {
  const crossings = createBorderCrossingOrchestrator(ctx);
  return {
    id: "border-crossings",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => crossings.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return CROSSING_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const bands = selectedOptions(filters, "wait");
      const found = await crossings.search(toBBox(bbox));
      const kept =
        bands.size > 0 ? found.sites.filter((c) => bands.has(variantOf(c))) : found.sites;
      const result = wrapSiteResult(kept.map(mapCrossingToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const crossing = await crossings.find(itemId);
      if (!crossing) return wrapSiteResult(null, []);
      return wrapSiteResult(mapCrossingToDetail(crossing), crossing.attributions);
    },
  };
}
