import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import { CATEGORY_FILTERS } from "@openmapx/core";
import {
  createManifestAttribution,
  isInColdStart,
  type Logger,
  type MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { deduplicateParking, haversineMeters } from "./dedup.js";
import { mapParkingToDetail, mapParkingToResult } from "./mapper.js";
import { PARKING_SOURCE_REGISTRY } from "./registry.js";

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

const MAX_CACHE_SIZE = 3000;

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

// PoiReader-backed parking sources whose cold-start state should flip
// `freshness.isStale=true` on the wrapped result. Hardcoded (rather than
// derived from `declarePoiSources()`) to avoid a circular import with
// poi-sources.ts; the list mirrors every entry registered there.
const POI_READER_BACKED_PARKING_SOURCES = [
  "utmc-newcastle",
  "brussels-be",
  "madrid-es",
  "nrw-mobidrom-parking",
  "nrw-mobidrom-pr",
  "apag",
  "apag-mobidrom",
  "apcoa",
  "parkapi-v3",
  "parkapi-v2",
  "basel-ch",
  "copenhagen-dk",
  "florence-it",
  "ghent-be",
  "vienna-at",
  "bnls-fr",
  "barcelona-es",
  "cita-lu",
  "ndw-truck-nl",
  "opendatahub-it",
  "opentransportdata-ch-parking",
  "autobahn-de",
  "db-bahnpark",
  "nsw-au",
  "singapore",
  "rdw-nl",
  "goldbeck",
] as const;

function anyParkingSourceColdStart(): boolean {
  return POI_READER_BACKED_PARKING_SOURCES.some((id) => isInColdStart(id));
}

const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(
    data,
    attributions,
    freshnessNow({ hasRealtimeData: false, isStale: anyParkingSourceColdStart() }),
  );

function attributionsForFacility(facility: ParkingFacility): Attribution[] {
  return attribution.forResults([facility], (f) => f.sources);
}

class ParkingDataSourceProvider implements MobilityDataSourceProvider {
  readonly id = "parking";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 60;
  readonly detailCacheTtl = 60;
  get attribution(): Attribution[] {
    return attribution.all();
  }

  private log: Logger | null = null;
  private facilityCache = new Map<string, ParkingFacility>();

  setLogger(logger: Logger): void {
    this.log = logger;
  }

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

  async search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>> {
    const results = await Promise.allSettled(
      PARKING_SOURCE_REGISTRY.map((source) => source.search(bbox)),
    );

    let allRejected = true;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        this.log?.warn(`parking source ${PARKING_SOURCE_REGISTRY[i].id} failed`, r.reason);
      } else {
        allRejected = false;
      }
    }
    if (allRejected && this.log) {
      this.log.error("all parking sources failed");
    }

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

    const mapped = filtered.map(mapParkingToResult);
    return wrapStatic(
      mapped,
      attribution.forResults(mapped, (r) => r.sources ?? r.source),
    );
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    // Try in-memory cache first — contains merged data from search
    const cached = this.facilityCache.get(itemId);
    if (cached) return wrapStatic(mapParkingToDetail(cached), attributionsForFacility(cached));

    // Cache miss: fetch the primary source, then try to enrich with
    // data from other sources so detail always has merged information.
    const primary = await this.fetchByPrefix(itemId);
    if (!primary) {
      return wrapStatic(
        {
          id: itemId,
          sources: ["unknown"],
          name: "Parking",
          coordinates: [0, 0],
          sections: [],
        },
        [],
      );
    }

    // Enrich: fetch nearby data from other sources and merge
    const enriched = await this.enrichFacility(primary);
    this.cacheFacility(enriched);
    return wrapStatic(mapParkingToDetail(enriched), attributionsForFacility(enriched));
  }

  private async fetchByPrefix(itemId: string): Promise<ParkingFacility | null> {
    for (const source of PARKING_SOURCE_REGISTRY) {
      if (!source.canFetchDetail?.(itemId) || !source.fetchDetail) continue;
      const facility = await source.fetchDetail(itemId);
      if (facility) return facility;
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

    const enrichResults = await Promise.allSettled(
      PARKING_SOURCE_REGISTRY.map((source) => source.search(bbox)),
    );

    for (let i = 0; i < enrichResults.length; i++) {
      const r = enrichResults[i];
      if (r.status === "rejected") {
        this.log?.warn(`parking source ${PARKING_SOURCE_REGISTRY[i].id} failed`, r.reason);
      }
    }

    const nearby = enrichResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    // Merge: run dedup on the primary + all nearby results
    const merged = deduplicateParking([facility, ...nearby]);

    // Find the merged version of our facility. The merged cluster may have
    // adopted a higher-priority member's coordinates/id, so match by the
    // cluster that contains our source, falling back to spatial proximity.
    const enriched =
      merged.find((f) => f.sources.some((s) => facility.sources.includes(s))) ??
      merged.find((f) => haversineMeters(f.coordinates, facility.coordinates) <= 150);

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

export function setLogger(logger: Logger): void {
  parkingProvider.setLogger(logger);
}
