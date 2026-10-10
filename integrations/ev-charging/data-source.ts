import type {
  BoundingBox,
  ConnectorStandard,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
} from "@openmapx/core";
import { CATEGORY_FILTERS, connectorStandardOf } from "@openmapx/core";
import {
  type ChargingSite,
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
import { mapChargingSiteToDetail, mapChargingSiteToResult, outOfService } from "./mapper.js";
import { createChargingSiteOrchestrator } from "./orchestrator.js";

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

/** The vehicle connectors a charger can be filtered by, as a garage vehicle lists them. */
const CONNECTOR_OPTIONS: { id: ConnectorStandard; label: string }[] = [
  { id: "ccs2", label: "CCS2" },
  { id: "ccs1", label: "CCS1" },
  { id: "chademo", label: "CHAdeMO" },
  { id: "type2", label: "Type 2" },
  { id: "type1", label: "Type 1" },
  { id: "nacs", label: "NACS / Tesla" },
  { id: "gbt_ac", label: "GB/T AC" },
  { id: "gbt_dc", label: "GB/T DC" },
  { id: "type3", label: "Type 3" },
];

const EV_FILTERS: DataSourceFilterDef[] = [
  { id: "connector", label: "Connector", type: "multi-select", options: CONNECTOR_OPTIONS },
  {
    id: "speed",
    label: "Charging Speed",
    type: "multi-select",
    clientSide: true,
    options: [
      { id: "slow", label: "Slow (≤22 kW)" },
      { id: "fast", label: "Fast (≤100 kW)" },
      { id: "ultra-rapid", label: "Ultra-Rapid (>100 kW)" },
    ],
  },
  {
    id: "access",
    label: "Access",
    type: "multi-select",
    options: [
      { id: "public", label: "Public" },
      { id: "restricted", label: "Restricted" },
    ],
  },
  { id: "hide_out_of_service", label: "Hide out of service", type: "toggle" },
  { id: "available_now", label: "Available now", type: "toggle", clientSide: true },
];

/** Seconds a search answer is cached: charge point status moves by the minute. */
const SEARCH_CACHE_TTL_S = 60;
/** Seconds a site detail is cached; it shows the same status a search does. */
const DETAIL_CACHE_TTL_S = 60;

/** The vehicle connectors a site serves. */
function standardsOf(site: ChargingSite): Set<string> {
  const standards = new Set<string>();
  for (const evse of site.evses) {
    for (const connector of evse.connectors) {
      const standard = connectorStandardOf(connector.standard);
      if (standard) standards.add(standard);
    }
  }
  return standards;
}

/** A site without a stated audience is taken to be public; every other audience is restricted. */
function accessOf(site: ChargingSite): "public" | "restricted" {
  return site.audience === undefined || site.audience === "public" ? "public" : "restricted";
}

/**
 * Whether a site passes the filters the orchestrator applies; within one
 * filter any selected option matches. Out of service hides planned sites
 * too: neither can be charged at. `speed` and `available_now` are the
 * client's, on the results.
 */
function matches(site: ChargingSite, filters: Record<string, unknown> | undefined): boolean {
  const connectors = selectedOptions(filters, "connector");
  if (connectors.size > 0) {
    const standards = standardsOf(site);
    if (![...connectors].some((c) => standards.has(c))) return false;
  }
  const access = selectedOptions(filters, "access");
  if (access.size > 0 && !access.has(accessOf(site))) return false;
  return !(filters?.hide_out_of_service === true && (outOfService(site) || site.planned));
}

/**
 * The `ev-charging` data source: every registered charging-site provider
 * merged behind one search and one detail. The connector, access and
 * out-of-service filters are applied here, on the merged sites. It is listed
 * only while a provider is registered, and a search some provider answered
 * only in part is marked partial with the reason, so the host does not cache
 * it and the map says a closer view loads more only when it does.
 */
export function createEvChargingDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const sites = createChargingSiteOrchestrator(ctx);
  return {
    id: "ev-charging",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => sites.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return EV_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box would make the
      // providers fetch a region's sites, so it is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrapSiteResult([], []);
      const found = await sites.search(toBBox(bbox));
      const kept = found.sites.filter((s) => matches(s, filters));
      const result = wrapSiteResult(kept.map(mapChargingSiteToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const site = await sites.find(itemId);
      if (!site) return wrapSiteResult(null, []);
      return wrapSiteResult(mapChargingSiteToDetail(site), site.attributions);
    },
  };
}
