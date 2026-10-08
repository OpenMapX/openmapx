import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
} from "@openmapx/core";
import {
  type CameraType,
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
import { mapCameraToDetail, mapCameraToResult } from "./mapper.js";
import { createCameraOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 8,
  placeCategory: "Webcam",
  placeCategoryRaw: "webcam",
  markerStyle: {
    variantColors: {
      landscape: "#4CAF50",
      traffic: "#FF9800",
      city: "#2196F3",
      weather: "#9C27B0",
      beach: "#00BCD4",
      other: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath:
      "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
  },
};

/** The camera types, which are also the marker variants. */
const CATEGORY_OPTIONS: { id: CameraType; label: string }[] = [
  { id: "landscape", label: "Landscape" },
  { id: "traffic", label: "Traffic" },
  { id: "city", label: "City" },
  { id: "weather", label: "Weather" },
  { id: "beach", label: "Beach" },
  { id: "other", label: "Other" },
];

const WEBCAM_FILTERS: DataSourceFilterDef[] = [
  { id: "category", label: "Category", type: "multi-select", options: CATEGORY_OPTIONS },
];

/** Seconds a search answer is cached: views go offline and come back by the minute. */
const SEARCH_CACHE_TTL_S = 60;
/** Seconds a camera detail is cached; its still URLs and times move faster than the list. */
const DETAIL_CACHE_TTL_S = 30;

/**
 * The `webcam` data source: every registered camera provider merged behind
 * one search and one detail. The category filter (the camera's type) is
 * passed to the providers as a hint and applied here again. It is listed
 * only while a provider is registered, and a search some provider answered
 * only in part is marked partial with the reason, so the host does not cache
 * it.
 */
export function createWebcamDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const cameras = createCameraOrchestrator(ctx);
  return {
    id: "webcam",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => cameras.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return WEBCAM_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box would make the
      // providers fetch a region's cameras, so it is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const types = selectedOptions(filters, "category");
      const found = await cameras.search(
        toBBox(bbox),
        types.size > 0 ? { types: [...types] as CameraType[] } : undefined,
      );
      const kept = types.size > 0 ? found.sites.filter((c) => types.has(c.type)) : found.sites;
      const result = wrapSiteResult(kept.map(mapCameraToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const camera = await cameras.find(itemId);
      if (!camera) return wrapSiteResult(null, []);
      return wrapSiteResult(mapCameraToDetail(camera), camera.attributions);
    },
  };
}
