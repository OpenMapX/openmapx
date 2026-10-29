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
import { mapVehicleToDetail, mapVehicleToResult, variantOf } from "./mapper.js";
import { createServiceVehicleOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 7,
  placeCategory: "Road maintenance vehicle",
  placeCategoryRaw: "road-maintenance-vehicle",
  markerStyle: {
    variantColors: {
      plowing: "#2196F3",
      spreading: "#FF9800",
      other: "#4CAF50",
      unknown: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath:
      "M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5m13.5-9 1.96 2.5H17V9.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5",
  },
};

/** What a vehicle is doing, which are also the marker variants. */
const WORK_OPTIONS = [
  { id: "plowing", label: "Ploughing" },
  { id: "spreading", label: "Salting or sanding" },
  { id: "other", label: "Other work" },
];

const VEHICLE_FILTERS: DataSourceFilterDef[] = [
  { id: "work", label: "Work", type: "multi-select", options: WORK_OPTIONS },
];

/** Seconds a search answer is cached: vehicles report every minute or so. */
const SEARCH_CACHE_TTL_S = 30;
/** Seconds a vehicle's detail is cached. */
const DETAIL_CACHE_TTL_S = 15;

/**
 * The `road-maintenance` data source: every registered service-vehicle
 * provider merged behind one search and one detail. The work filter
 * (ploughing, salting or sanding, other work) is applied here. It is listed
 * only while a provider is registered, and a search some provider answered
 * only in part is marked partial with the reason, so the host does not
 * cache it.
 */
export function createRoadMaintenanceDataSource(
  ctx: IntegrationContext,
): MobilityDataSourceProvider {
  const vehicles = createServiceVehicleOrchestrator(ctx);
  return {
    id: "road-maintenance",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => vehicles.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return VEHICLE_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const work = selectedOptions(filters, "work");
      const found = await vehicles.search(toBBox(bbox));
      const kept = work.size > 0 ? found.sites.filter((v) => work.has(variantOf(v))) : found.sites;
      const result = wrapSiteResult(kept.map(mapVehicleToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const vehicle = await vehicles.find(itemId);
      if (!vehicle) return wrapSiteResult(null, []);
      return wrapSiteResult(mapVehicleToDetail(vehicle), vehicle.attributions);
    },
  };
}
