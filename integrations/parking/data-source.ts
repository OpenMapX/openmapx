import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import {
  type DataSourceSearchResult,
  type IntegrationContext,
  type MobilityDataSourceProvider,
  type ParkingSite,
  selectedOptions as selected,
  siteAttributions,
  toBBox,
  withinZoom,
  wrapSiteResult as wrap,
} from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import { mapParkingSiteToDetail, mapParkingSiteToResult } from "./mapper.js";
import { createParkingSiteOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 12,
  showResultsList: true,
  placeCategory: "Parking",
  placeCategoryRaw: "parking",
  osmFilters: CATEGORY_FILTERS.parking,
  markerStyle: {
    type: "circle",
    variantColors: {
      available: "#4CAF50",
      limited: "#FF9800",
      full: "#F44336",
      closed: "#9E9E9E",
      unknown: "#2196F3",
    },
    defaultColor: "#2196F3",
    inactiveOpacity: 0.4,
    iconPath:
      "M13 3H6v18h4v-6h3c3.31 0 6-2.69 6-6s-2.69-6-6-6m.2 8H10V7h3.2c1.1 0 2 .9 2 2s-.9 2-2 2",
  },
};

const PARKING_FILTERS: DataSourceFilterDef[] = [
  {
    id: "parkingType",
    label: "Type",
    type: "multi-select",
    options: [
      { id: "garage", label: "Parking Garage" },
      { id: "underground", label: "Underground" },
      { id: "surface", label: "Surface Lot" },
      { id: "on-street", label: "On-Street" },
    ],
  },
  {
    id: "fee",
    label: "Fee",
    type: "multi-select",
    options: [
      { id: "free", label: "Free" },
      { id: "paid", label: "Paid" },
      { id: "unknown", label: "Unknown" },
    ],
  },
  {
    id: "availability",
    label: "Availability",
    type: "multi-select",
    options: [
      { id: "available", label: "Spaces Available" },
      { id: "full", label: "Include Full" },
    ],
  },
  {
    id: "features",
    label: "Features",
    type: "multi-select",
    options: [
      { id: "disabled", label: "Disabled Parking" },
      { id: "ev-charging", label: "EV Charging" },
      { id: "park-and-ride", label: "Park & Ride" },
    ],
  },
];

/** Seconds a search answer is cached: occupancy moves by the minute. */
const SEARCH_CACHE_TTL_S = 60;
/** Seconds a site detail is cached; it shows the same counts a search does. */
const DETAIL_CACHE_TTL_S = 60;

const GARAGE_LAYOUTS = new Set(["multi_storey", "automated", "covered", "nested"]);
const SURFACE_LAYOUTS = new Set(["surface", "single_level"]);

/** The `parkingType` options a site answers to. */
function parkingTypes(site: ParkingSite): Set<string> {
  const types = new Set<string>();
  const layout = site.layout === "unknown" ? undefined : site.layout;
  if (site.type === "on_street") types.add("on-street");
  if (layout === "underground") types.add("underground");
  if (layout && GARAGE_LAYOUTS.has(layout)) types.add("garage");
  if (layout && SURFACE_LAYOUTS.has(layout)) types.add("surface");
  if (!layout && site.type !== undefined && site.type !== "on_street") types.add("surface");
  return types;
}

function fee(site: ParkingSite): "free" | "paid" | "unknown" {
  if (site.free === true) return "free";
  if (site.free === false || site.rates.length > 0) return "paid";
  return "unknown";
}

function hasArea(site: ParkingSite, userGroup: string): boolean {
  return site.areas.some((a) => a.userGroup === userGroup);
}

function hasFeature(site: ParkingSite, feature: string): boolean {
  switch (feature) {
    case "disabled":
      return hasArea(site, "disabled");
    case "ev-charging":
      return hasArea(site, "ev_charging");
    case "park-and-ride":
      return site.type === "park_and_ride";
    default:
      return true;
  }
}

/**
 * A fresh count of no free spaces, or a fresh status of full, as the marker
 * shows it; a stale or missing reading may still have room.
 */
function knownFull(site: ParkingSite): boolean {
  return !site.stale && (site.available === 0 || site.status === "full");
}

/** Whether a site passes the filters; within one filter any selected option matches, features all must. */
function matches(site: ParkingSite, filters: Record<string, unknown> | undefined): boolean {
  const types = selected(filters, "parkingType");
  if (types.size > 0 && ![...parkingTypes(site)].some((t) => types.has(t))) return false;
  const fees = selected(filters, "fee");
  if (fees.size > 0 && !fees.has(fee(site))) return false;
  const availability = selected(filters, "availability");
  if (availability.has("available") && !availability.has("full") && knownFull(site)) return false;
  const features = selected(filters, "features");
  return [...features].every((f) => hasFeature(site, f));
}

/**
 * The `parking` data source: every registered parking-site provider merged
 * behind one search and one detail. The filters are applied here, on the
 * merged sites. It is listed only while a provider is registered, and a
 * search some provider answered only in part is marked partial with the
 * reason, so the host does not cache it and the map says a closer view loads
 * more only when it does.
 */
export function createParkingDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const sites = createParkingSiteOrchestrator(ctx);
  return {
    id: "parking",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => sites.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return PARKING_FILTERS;
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box would make the
      // providers fetch a region's sites, so it is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrap([], []);
      const found = await sites.search(toBBox(bbox));
      const kept = found.sites.filter((s) => matches(s, filters));
      const result = wrap(kept.map(mapParkingSiteToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const site = await sites.find(itemId);
      if (!site) return wrap(null, []);
      return wrap(mapParkingSiteToDetail(site), site.attributions);
    },
  };
}
