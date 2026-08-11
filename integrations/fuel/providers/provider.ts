import { resolveBrand } from "@openmapx/brands";
import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  commonsLogoUrl,
  extractSourcePrefix,
  fetchJson,
  searchByCategory,
} from "@openmapx/core";
import type { MobilityDataSourceProvider } from "@openmapx/integration-framework";
import { createManifestAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { getDeTankerkoenigApiKey, searchFuelStations } from "./factory.js";
import {
  buildDeTankerkoenigDetail,
  mapFuelStationToDetail,
  mapFuelStationToResult,
} from "./mapper.js";

const DE_TANKERKOENIG_DETAIL_URL = "https://creativecommons.tankerkoenig.de/json/detail.php";

interface DeTankerkoenigDetailStation {
  id: string;
  name: string;
  brand: string;
  openingTimes: { text: string; start: string; end: string }[];
  overrides: string[];
  wholeDay: boolean;
  isOpen: boolean;
  e5: number | false | null;
  e10: number | false | null;
  diesel: number | false | null;
}

interface DeTankerkoenigDetailResponse {
  ok: boolean;
  station?: DeTankerkoenigDetailStation;
  message?: string;
}

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

const MAX_CACHE_SIZE = 2000;

// Manifest-driven attribution store. Populated by `setManifestDataSources`
// during `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

const wrapStatic = <T>(data: T, attribution: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attribution, freshnessNow({ hasRealtimeData: false }));

class FuelDataSourceProvider implements MobilityDataSourceProvider {
  readonly id = "fuel";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;
  get attribution(): Attribution[] {
    return attribution.all();
  }

  /** In-memory cache of stations seen during search, for detail lookups. */
  private stationCache = new Map<string, FuelStation>();

  private cacheStation(station: FuelStation): void {
    // Evict oldest entries when cache is full
    if (this.stationCache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.stationCache.keys().next().value;
      if (firstKey !== undefined) {
        this.stationCache.delete(firstKey);
      }
    }
    this.stationCache.set(station.id, station);
  }

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
  }

  async search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>> {
    let results: DataSourceResult[];

    const fuelStations = await searchFuelStations(bbox);

    if (fuelStations !== null) {
      // Cache stations for detail lookups
      for (const station of fuelStations) {
        this.cacheStation(station);
      }
      results = fuelStations.map(mapFuelStationToResult);
    } else {
      // Fallback to Overpass for areas without dedicated fuel price providers
      const osmFilters = CATEGORY_FILTERS.fuel;
      if (!osmFilters) return wrapStatic([], []);
      const { results: osmResults } = await searchByCategory(osmFilters, bbox);
      results = osmResults.map((r) => {
        const result: DataSourceResult = {
          id: r.id,
          name: r.name,
          coordinates: r.coordinates,
          source: "osm",
          variant: "unknown",
          status: "unknown",
        };
        // Gap-fill only. This Overpass fallback carries real OSM tags (unlike
        // the priced national feeds above, which supply only a plain-string
        // brand name with no wikidata identity — never guessed at).
        if (!result.branding?.logoUrl) {
          const catalogued = resolveBrand(r.osmTags);
          if (catalogued?.logoFile) {
            result.branding = {
              ...result.branding,
              name: result.branding?.name ?? catalogued.name,
              logoUrl: commonsLogoUrl(catalogued.logoFile, 96),
            };
          }
        }
        return result;
      });
    }

    // Apply fuelType filter
    if (filters?.fuelType) {
      const fuelTypes = Array.isArray(filters.fuelType)
        ? (filters.fuelType as string[])
        : [String(filters.fuelType)];
      if (fuelTypes.length > 0) {
        const fuelTypeSet = new Set(fuelTypes);
        results = results.filter((r) => {
          const cached = this.stationCache.get(r.id);
          if (!cached) return true; // Keep OSM-only results (no price data to filter on)
          return Array.from(fuelTypeSet).some(
            (ft) => cached.fuelPrices[ft as keyof typeof cached.fuelPrices] !== undefined,
          );
        });
      }
    }

    return wrapStatic(results, attribution.forResults(results));
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const detail = await this.fetchDetail(itemId);
    const sourceKey = detail ? extractSourcePrefix(detail.id) : "";
    const attr = sourceKey ? attribution.bySource(sourceKey) : undefined;
    return wrapStatic(detail, attr ? [attr] : []);
  }

  private async fetchDetail(itemId: string): Promise<DataSourceDetail | null> {
    // DE tankerkoenig stations: fetch enriched detail from their API
    if (itemId.startsWith("de-tankerkoenig/")) {
      const uuid = itemId.replace(/^de-tankerkoenig\//, "");
      const apiKey = getDeTankerkoenigApiKey();

      if (apiKey && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
        try {
          const url = new URL(DE_TANKERKOENIG_DETAIL_URL);
          url.searchParams.set("id", uuid);
          url.searchParams.set("apikey", apiKey);

          const data = await fetchJson<DeTankerkoenigDetailResponse>(url.toString(), {
            nullOnError: true,
          });
          if (data?.ok && data.station) {
            const s = data.station;
            const cachedStation = this.stationCache.get(itemId);
            const baseStation: FuelStation = cachedStation ?? {
              id: itemId,
              name: s.brand && s.brand !== s.name ? `${s.brand} ${s.name}` : s.name,
              brand: s.brand || undefined,
              coordinates: [0, 0], // Will be overridden if cached
              fuelPrices: {
                e5: s.e5 != null && s.e5 !== false ? s.e5 : undefined,
                e10: s.e10 != null && s.e10 !== false ? s.e10 : undefined,
                diesel: s.diesel != null && s.diesel !== false ? s.diesel : undefined,
              },
            };

            return buildDeTankerkoenigDetail(baseStation, {
              isOpen: s.isOpen,
              wholeDay: s.wholeDay,
              openingTimes: s.openingTimes ?? [],
              overrides: s.overrides ?? [],
              fuelPrices: {
                e5: s.e5 != null && s.e5 !== false ? s.e5 : undefined,
                e10: s.e10 != null && s.e10 !== false ? s.e10 : undefined,
                diesel: s.diesel != null && s.diesel !== false ? s.diesel : undefined,
              },
            });
          }
        } catch {
          // Fall through to cached/minimal detail
        }
      }
    }

    // Try in-memory cache
    const cached = this.stationCache.get(itemId);
    if (cached) {
      return mapFuelStationToDetail(cached);
    }

    return null;
  }
}

export const fuelProvider = new FuelDataSourceProvider();
