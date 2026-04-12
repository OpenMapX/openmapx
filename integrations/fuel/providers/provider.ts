import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { CATEGORY_FILTERS, searchByCategory } from "@openmapx/core";
import type { DataSourceProvider } from "../../data-source/types.js";
import { searchFuelStations } from "./factory.js";
import {
  buildTankerkoenigDetail,
  mapFuelStationToDetail,
  mapFuelStationToResult,
} from "./mapper.js";
import type { FuelStation } from "./types.js";

const TANKERKOENIG_DETAIL_URL = "https://creativecommons.tankerkoenig.de/json/detail.php";

interface TankerkoenigDetailStation {
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

interface TankerkoenigDetailResponse {
  ok: boolean;
  station?: TankerkoenigDetailStation;
  message?: string;
}

const META: DataSourceMeta = {
  minZoom: 8,
  showResultsList: true,
  placeCategory: "Gas Station",
  placeCategoryRaw: "fuel",
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

class FuelDataSourceProvider implements DataSourceProvider {
  readonly id = "fuel";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;

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

  async search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]> {
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
      if (!osmFilters) return [];
      const osmResults = await searchByCategory(osmFilters, bbox);
      results = osmResults.map((r) => ({
        id: r.id,
        name: r.name,
        coordinates: r.coordinates,
        source: "osm",
        variant: "unknown",
        status: "unknown",
      }));
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

    return results;
  }

  async getDetail(itemId: string): Promise<DataSourceDetail | null> {
    // Tankerkoenig stations: fetch enriched detail from their API
    if (itemId.startsWith("tankerkoenig/")) {
      const uuid = itemId.replace(/^tankerkoenig\//, "");
      const apiKey = process.env.TANKERKOENIG_API_KEY;

      if (apiKey && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
        try {
          const url = new URL(TANKERKOENIG_DETAIL_URL);
          url.searchParams.set("id", uuid);
          url.searchParams.set("apikey", apiKey);

          const res = await fetch(url.toString());
          if (res.ok) {
            const data = (await res.json()) as TankerkoenigDetailResponse;
            if (data.ok && data.station) {
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

              return buildTankerkoenigDetail(baseStation, {
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
