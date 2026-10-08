import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import {
  type DataSourceSearchResult,
  type FuelStation,
  type FuelStationQuery,
  type IntegrationContext,
  type MobilityDataSourceProvider,
  selectedOptions,
  siteAttributions,
  toBBox,
  withinZoom,
  wrapSiteResult as wrap,
} from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import { mapFuelStationToDetail, mapFuelStationToResult } from "./mapper.js";
import { createFuelStationOrchestrator } from "./orchestrator.js";

const META: DataSourceMeta = {
  minZoom: 8,
  showResultsList: true,
  placeCategory: "Gas Station",
  placeCategoryRaw: "fuel",
  osmFilters: CATEGORY_FILTERS.fuel,
  markerStyle: {
    type: "icon",
    variantColors: {},
    defaultColor: "#E54033",
    inactiveOpacity: 0.5,
    iconPath:
      "m19.77 7.23.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1",
  },
};

/** Seconds a search answer is cached: fuel prices move a few times a day at most. */
const SEARCH_CACHE_TTL_S = 120;
/** Seconds a station detail is cached; it shows the same prices a search does. */
const DETAIL_CACHE_TTL_S = 120;

function requestedGrades(filters: Record<string, unknown> | undefined): string[] {
  return [...selectedOptions(filters, "fuelType")];
}

function sells(station: FuelStation, grades: readonly string[]): boolean {
  return station.products.some((p) => p.available !== false && grades.includes(p.grade));
}

function hasPrice(station: FuelStation): boolean {
  return station.products.some((p) => p.available !== false && p.price !== undefined);
}

/**
 * The `fuel` data source: every registered fuel-station provider merged
 * behind one search and one detail. Filters are pushed to the providers and
 * re-applied here, so a provider that ignores them cannot widen the answer.
 * It is listed only while a provider is registered, and a search some
 * provider answered only in part is marked partial with the reason, so the
 * host does not cache it and the map says a closer view loads more only when
 * it does.
 */
export function createFuelDataSource(ctx: IntegrationContext): MobilityDataSourceProvider {
  const stations = createFuelStationOrchestrator(ctx);
  return {
    id: "fuel",
    meta: META,
    serviceIds: [],
    searchCacheTtl: SEARCH_CACHE_TTL_S,
    detailCacheTtl: DETAIL_CACHE_TTL_S,
    attribution: [],

    isAvailable: () => stations.providers().length > 0,

    async getFilters(): Promise<DataSourceFilterDef[]> {
      return [
        {
          id: "fuelType",
          label: "Fuel Type",
          type: "multi-select",
          options: [
            { id: "diesel", label: "Diesel" },
            { id: "e5", label: "E5 (Super 95)" },
            { id: "e10", label: "E10" },
            { id: "sp98", label: "SP98 (Super 98)" },
            { id: "e85", label: "E85 (Ethanol)" },
            { id: "lpg", label: "LPG (Autogas)" },
          ],
        },
      ];
    },

    async search(
      bbox: BoundingBox,
      filters?: Record<string, unknown>,
    ): Promise<DataSourceSearchResult> {
      // The map asks only from `minZoom` on; a wider box would make the
      // providers fetch a country's stations, so it is answered empty.
      if (!withinZoom(bbox, META.minZoom)) return wrap([], []);
      const grades = requestedGrades(filters);
      const pricesOnly = filters?.pricesOnly === true;
      const query: FuelStationQuery = {
        ...(pricesOnly ? { pricesOnly } : {}),
        ...(grades.length > 0 ? { grades } : {}),
      };
      const found = await stations.search(toBBox(bbox), query);
      const kept = found.sites.filter(
        (s) => (grades.length === 0 || sells(s, grades)) && (!pricesOnly || hasPrice(s)),
      );
      const result = wrap(kept.map(mapFuelStationToResult), siteAttributions(kept));
      return found.partial ? { ...result, partial: found.partial } : result;
    },

    async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
      const station = await stations.find(itemId);
      if (!station) return wrap(null, []);
      return wrap(mapFuelStationToDetail(station), station.attributions);
    },
  };
}
