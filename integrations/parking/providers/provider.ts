import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { DataSourceProvider } from "../../data-source/types.js";
import { fetchAutobahnDeDetail, searchAutobahnDe } from "./autobahn-de.js";
import { fetchBarcelonaEsDetail, searchBarcelonaEs } from "./barcelona-es.js";
import { fetchBaselChDetail, searchBaselCh } from "./basel-ch.js";
import { fetchBnlsFrDetail, searchBnlsFr } from "./bnls-fr.js";
import { fetchBrusselsBeDetail, searchBrusselsBe } from "./brussels-be.js";
import { fetchCopenhagenDkDetail, searchCopenhagenDk } from "./copenhagen-dk.js";
import { fetchDbBahnParkDetail, searchDbBahnPark } from "./db-bahnpark.js";
import { deduplicateParking } from "./dedup.js";
import { fetchFlorenceItDetail, searchFlorenceIt } from "./florence-it.js";
import { fetchGhentBeDetail, searchGhentBe } from "./ghent-be.js";
import { fetchMadridEsDetail, searchMadridEs } from "./madrid-es.js";
import { mapParkingToDetail, mapParkingToResult } from "./mapper.js";
import { fetchNdwTruckNlDetail, searchNdwTruckNl } from "./ndw-truck-nl.js";
import { fetchNswAuDetail, searchNswAu } from "./nsw-au.js";
import { fetchOdhItDetail, searchOdhIt } from "./opendatahub-it.js";
import { fetchOsmParkingElement, searchOsmParking } from "./osm.js";
import { fetchParkApiV2Detail, searchParkApiV2 } from "./parkapi-v2.js";
import { fetchParkApiV3Detail, searchParkApiV3 } from "./parkapi-v3.js";
import { fetchRdwNlDetail, searchRdwNl } from "./rdw-nl.js";
import { fetchSingaporeDetail, searchSingapore } from "./singapore.js";
import type { ParkingFacility } from "./types.js";
import { fetchUtmcNewcastleDetail, searchUtmcNewcastle } from "./utmc-newcastle.js";
import { fetchViennaAtDetail, searchViennaAt } from "./vienna-at.js";

const META: DataSourceMeta = {
  minZoom: 12,
  showResultsList: true,
  placeCategory: "Parking",
  placeCategoryRaw: "parking",
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

const MAX_CACHE_SIZE = 3000;

class ParkingDataSourceProvider implements DataSourceProvider {
  readonly id = "parking";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 60;
  readonly detailCacheTtl = 60;

  private facilityCache = new Map<string, ParkingFacility>();

  private cacheFacility(facility: ParkingFacility): void {
    if (this.facilityCache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.facilityCache.keys().next().value;
      if (firstKey !== undefined) this.facilityCache.delete(firstKey);
    }
    this.facilityCache.set(facility.id, facility);
  }

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return PARKING_FILTERS;
  }

  async search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]> {
    // Query all sources in parallel, ordered by priority (DB > v3 > v2 > regional > OSM)
    const results = await Promise.allSettled([
      searchDbBahnPark(bbox),
      searchParkApiV3(bbox),
      searchParkApiV2(bbox),
      searchRdwNl(bbox),
      searchBnlsFr(bbox),
      searchGhentBe(bbox),
      searchBrusselsBe(bbox),
      searchBaselCh(bbox),
      searchFlorenceIt(bbox),
      searchBarcelonaEs(bbox),
      searchViennaAt(bbox),
      searchCopenhagenDk(bbox),
      searchSingapore(bbox),
      searchMadridEs(bbox),
      searchUtmcNewcastle(bbox),
      searchNswAu(bbox),
      searchNdwTruckNl(bbox),
      searchAutobahnDe(bbox),
      searchOdhIt(bbox),
      searchOsmParking(bbox),
    ]);

    const allFacilities = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const deduped = deduplicateParking(allFacilities);

    // Cache for detail lookups
    for (const f of deduped) {
      this.cacheFacility(f);
    }

    // Apply filters
    let filtered = deduped;
    filtered = this.applyTypeFilter(filtered, filters);
    filtered = this.applyFeeFilter(filtered, filters);
    filtered = this.applyAvailabilityFilter(filtered, filters);
    filtered = this.applyFeaturesFilter(filtered, filters);

    return filtered.map(mapParkingToResult);
  }

  async getDetail(itemId: string): Promise<DataSourceDetail | null> {
    // Try in-memory cache first — contains merged data from search
    const cached = this.facilityCache.get(itemId);
    if (cached) return mapParkingToDetail(cached);

    // Cache miss: fetch the primary source, then try to enrich with
    // data from other sources so detail always has merged information.
    const primary = await this.fetchByPrefix(itemId);
    if (!primary) {
      return {
        id: itemId,
        sources: ["unknown"],
        name: "Parking",
        coordinates: [0, 0],
        sections: [],
      };
    }

    // Enrich: fetch nearby data from other sources and merge
    const enriched = await this.enrichFacility(primary);
    this.cacheFacility(enriched);
    return mapParkingToDetail(enriched);
  }

  private async fetchByPrefix(itemId: string): Promise<ParkingFacility | null> {
    if (itemId.startsWith("parkapi-v2:")) {
      const rest = itemId.slice("parkapi-v2:".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx > 0) {
        const cityName = rest.slice(0, slashIdx);
        const lotId = rest.slice(slashIdx + 1);
        return fetchParkApiV2Detail(cityName, lotId);
      }
    }

    if (itemId.startsWith("parkapi-v3:")) {
      const siteId = Number.parseInt(itemId.slice("parkapi-v3:".length), 10);
      if (!Number.isNaN(siteId)) return fetchParkApiV3Detail(siteId);
    }

    if (itemId.startsWith("db-bahnpark:")) {
      const facilityId = itemId.slice("db-bahnpark:".length);
      return fetchDbBahnParkDetail(facilityId);
    }

    if (itemId.startsWith("rdw:")) {
      const rest = itemId.slice("rdw:".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx > 0) {
        const areamanagerid = rest.slice(0, slashIdx);
        const areaid = rest.slice(slashIdx + 1);
        return fetchRdwNlDetail(areamanagerid, areaid);
      }
    }

    if (itemId.startsWith("bnls:")) return fetchBnlsFrDetail(itemId.slice("bnls:".length));
    if (itemId.startsWith("ghent:")) return fetchGhentBeDetail(itemId.slice("ghent:".length));
    if (itemId.startsWith("brussels:"))
      return fetchBrusselsBeDetail(itemId.slice("brussels:".length));
    if (itemId.startsWith("basel:")) return fetchBaselChDetail(itemId.slice("basel:".length));
    if (itemId.startsWith("florence:"))
      return fetchFlorenceItDetail(itemId.slice("florence:".length));
    if (itemId.startsWith("barcelona:"))
      return fetchBarcelonaEsDetail(itemId.slice("barcelona:".length));
    if (itemId.startsWith("vienna:")) return fetchViennaAtDetail(itemId.slice("vienna:".length));
    if (itemId.startsWith("copenhagen:"))
      return fetchCopenhagenDkDetail(itemId.slice("copenhagen:".length));
    if (itemId.startsWith("sg:")) return fetchSingaporeDetail(itemId.slice("sg:".length));
    if (itemId.startsWith("madrid:")) return fetchMadridEsDetail(itemId.slice("madrid:".length));
    if (itemId.startsWith("utmc:")) return fetchUtmcNewcastleDetail(itemId.slice("utmc:".length));
    if (itemId.startsWith("nsw:")) return fetchNswAuDetail(itemId.slice("nsw:".length));

    if (itemId.startsWith("ndw-truck:"))
      return fetchNdwTruckNlDetail(itemId.slice("ndw-truck:".length));
    if (itemId.startsWith("autobahn:"))
      return fetchAutobahnDeDetail(itemId.slice("autobahn:".length));
    if (itemId.startsWith("odh:")) return fetchOdhItDetail(itemId.slice("odh:".length));

    if (itemId.startsWith("osm:")) {
      const rest = itemId.slice("osm:".length);
      const [elementType, idStr] = rest.split("/");
      const elementId = Number.parseInt(idStr, 10);
      if (elementType && !Number.isNaN(elementId)) {
        return fetchOsmParkingElement(elementType, elementId);
      }
    }

    return null;
  }

  /**
   * Enrich a facility by searching a small bbox around it and merging
   * any co-located results from other sources.
   */
  private async enrichFacility(facility: ParkingFacility): Promise<ParkingFacility> {
    const [lng, lat] = facility.coordinates;
    const margin = 0.002; // ~200m
    const bbox: BoundingBox = {
      south: lat - margin,
      west: lng - margin,
      north: lat + margin,
      east: lng + margin,
    };

    // Fetch all sources in parallel for the tiny bbox
    const enrichResults = await Promise.allSettled([
      searchParkApiV2(bbox),
      searchParkApiV3(bbox),
      searchDbBahnPark(bbox),
      searchRdwNl(bbox),
      searchBnlsFr(bbox),
      searchGhentBe(bbox),
      searchBrusselsBe(bbox),
      searchBaselCh(bbox),
      searchFlorenceIt(bbox),
      searchBarcelonaEs(bbox),
      searchViennaAt(bbox),
      searchCopenhagenDk(bbox),
      searchSingapore(bbox),
      searchMadridEs(bbox),
      searchUtmcNewcastle(bbox),
      searchNswAu(bbox),
      searchNdwTruckNl(bbox),
      searchAutobahnDe(bbox),
      searchOdhIt(bbox),
      searchOsmParking(bbox),
    ]);

    const nearby = enrichResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    // Merge: run dedup on the primary + all nearby results
    const merged = deduplicateParking([facility, ...nearby]);

    // Find the merged version of our facility (same grid cell)
    const key = `${Math.round(lat * 1000)},${Math.round(lng * 1000)}`;
    const enriched = merged.find((f) => {
      const [fLng, fLat] = f.coordinates;
      return `${Math.round(fLat * 1000)},${Math.round(fLng * 1000)}` === key;
    });

    return enriched ?? facility;
  }

  private applyTypeFilter(
    facilities: ParkingFacility[],
    filters?: Record<string, unknown>,
  ): ParkingFacility[] {
    if (!filters?.parkingType) return facilities;
    const types = Array.isArray(filters.parkingType)
      ? (filters.parkingType as string[])
      : [String(filters.parkingType)];
    if (types.length === 0) return facilities;
    const typeSet = new Set(types);
    return facilities.filter((f) => typeSet.has(f.parkingType));
  }

  private applyFeeFilter(
    facilities: ParkingFacility[],
    filters?: Record<string, unknown>,
  ): ParkingFacility[] {
    if (!filters?.fee) return facilities;
    const fees = Array.isArray(filters.fee) ? (filters.fee as string[]) : [String(filters.fee)];
    if (fees.length === 0) return facilities;
    const feeSet = new Set(fees);
    return facilities.filter((f) => {
      const fee = f.fee === undefined || f.fee === "unknown" ? "unknown" : f.fee;
      return feeSet.has(fee);
    });
  }

  private applyAvailabilityFilter(
    facilities: ParkingFacility[],
    filters?: Record<string, unknown>,
  ): ParkingFacility[] {
    if (!filters?.availability) return facilities;
    const avail = Array.isArray(filters.availability)
      ? (filters.availability as string[])
      : [String(filters.availability)];
    if (avail.length === 0) return facilities;
    const availSet = new Set(avail);

    // If only "available" is selected, exclude full facilities (that have real-time data)
    if (availSet.has("available") && !availSet.has("full")) {
      return facilities.filter(
        (f) => !f.hasRealtimeData || f.freeSpaces === undefined || f.freeSpaces > 0,
      );
    }

    return facilities;
  }

  private applyFeaturesFilter(
    facilities: ParkingFacility[],
    filters?: Record<string, unknown>,
  ): ParkingFacility[] {
    if (!filters?.features) return facilities;
    const features = Array.isArray(filters.features)
      ? (filters.features as string[])
      : [String(filters.features)];
    if (features.length === 0) return facilities;
    const featureSet = new Set(features);

    return facilities.filter((f) => {
      if (featureSet.has("disabled") && (!f.disabledSpaces || f.disabledSpaces <= 0)) return false;
      if (featureSet.has("ev-charging") && (!f.chargingSpaces || f.chargingSpaces <= 0))
        return false;
      if (featureSet.has("park-and-ride") && !f.parkAndRide) return false;
      return true;
    });
  }
}

export const parkingProvider = new ParkingDataSourceProvider();
