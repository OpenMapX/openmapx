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
import { mapSignToDetail, mapSignToResult, variantOf } from "./mapper.js";
import { createMessageSignOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 8,
  placeCategory: "Message sign",
  placeCategoryRaw: "message-sign",
  markerStyle: {
    variantColors: {
      showing: "#F9A825",
      blank: "#9E9E9E",
      fault: "#E53935",
      unknown: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath:
      "M21 3H3c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h8v2H8v2h8v-2h-3v-2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12H3V5h18v10zM5 7h14v2H5zm0 4h10v2H5z",
  },
};

/** What a sign is doing, which are also the marker variants. */
const STATUS_OPTIONS = [
  { id: "showing", label: "Showing a message" },
  { id: "blank", label: "Blank" },
  { id: "fault", label: "Out of order" },
];

const SIGN_FILTERS: DataSourceFilterDef[] = [
  { id: "status", label: "Status", type: "multi-select", options: STATUS_OPTIONS },
];

/** Seconds a search answer is cached: a sign's message changes by the minute. */
const SEARCH_CACHE_TTL_S = 60;
/** Seconds a sign's detail is cached. */
const DETAIL_CACHE_TTL_S = 30;

/**
 * The `message-signs` data source: every registered message-sign provider
 * merged behind one search and one detail. The status filter (showing a
 * message, blank, out of order) is applied here. It is listed only while a
 * provider is registered, and a search some provider answered only in part
 * is marked partial with the reason, so the host does not cache it.
 */
export function createMessageSignDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const signs = createMessageSignOrchestrator(ctx);
  return {
    id: "message-signs",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => signs.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return SIGN_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const states = selectedOptions(filters, "status");
      const found = await signs.search(toBBox(bbox));
      const kept =
        states.size > 0 ? found.sites.filter((s) => states.has(variantOf(s))) : found.sites;
      const result = wrapSiteResult(kept.map(mapSignToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const sign = await signs.find(itemId);
      if (!sign) return wrapSiteResult(null, []);
      return wrapSiteResult(mapSignToDetail(sign), sign.attributions);
    },
  };
}
