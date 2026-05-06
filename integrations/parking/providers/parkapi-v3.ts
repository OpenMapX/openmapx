import type { BoundingBox } from "@openmapx/core";
import type { ParkApiV3Site, ParkApiV3Source, ParkingFacility, ParkingType } from "./types.js";

const API_BASE = "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites";
const SOURCES_API = "https://api.mobidata-bw.de/park-api/api/public/v3/sources";
const LIST_CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time data refreshes every ~5 min
const SOURCE_CACHE_TTL = 10 * 60 * 1000;
const REALTIME_STALE_AFTER_MS = 30 * 60 * 1000;

/** Rough bounding box for Germany + buffer (v3 covers all of DE, not just BW). */
const COVERAGE_BBOX = { south: 45.5, west: 5.5, north: 55.5, east: 15.5 };

let listCache: { sites: ParkingFacility[]; fetchedAt: number } | null = null;
let sourceCache: { sources: Map<string, ParkApiV3Source>; fetchedAt: number } | null = null;

const TYPE_MAP: Record<string, ParkingType> = {
  UNDERGROUND: "underground",
  CAR_PARK: "garage",
  OFF_STREET_PARKING_GROUND: "surface",
  ON_STREET: "on-street",
};

function mapType(type?: string): ParkingType {
  if (!type) return "unknown";
  return TYPE_MAP[type] ?? "unknown";
}

/** Check whether the search bbox overlaps the coverage area. */
export function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function isStaleTimestamp(value: string | undefined, staleAfterMs: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > staleAfterMs;
}

function normalizeSourceAttribution(source: ParkApiV3Source | undefined) {
  if (!source) return undefined;
  const license = source.attribution_license?.trim() || undefined;
  const contributor = source.attribution_contributor?.trim() || undefined;
  const url = source.attribution_url?.trim() || undefined;
  return {
    contributor,
    license,
    licenseUrl: url,
    name: contributor || source.name,
    url: source.public_url ?? undefined,
  };
}

function normalizeRealtime(site: ParkApiV3Site): {
  capacity?: number;
  freeSpaces?: number;
  hasRealtime: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const capacity =
    site.capacity ??
    (typeof site.realtime_capacity === "number" ? site.realtime_capacity : undefined);
  const rawFree =
    typeof site.realtime_free_capacity === "number" ? site.realtime_free_capacity : undefined;
  const hasRealtime = site.has_realtime_data === true && rawFree !== undefined;

  if (!hasRealtime) return { capacity, hasRealtime: false, warnings };

  let freeSpaces = rawFree;
  if (freeSpaces < 0) {
    warnings.push("Realtime free-space count was negative and was clamped to 0.");
    freeSpaces = 0;
  }
  if (capacity !== undefined && freeSpaces > capacity) {
    warnings.push("Realtime free-space count exceeded capacity and was clamped.");
    freeSpaces = capacity;
  }

  return { capacity, freeSpaces, hasRealtime, warnings };
}

function siteToFacility(
  site: ParkApiV3Site,
  source: ParkApiV3Source | undefined,
): ParkingFacility | null {
  if (site.purpose && site.purpose !== "CAR") return null;

  const lat = site.lat != null ? Number.parseFloat(site.lat) : undefined;
  const lon = site.lon != null ? Number.parseFloat(site.lon) : undefined;
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  const realtime = normalizeRealtime(site);
  const staticDataUpdatedAt =
    site.static_data_updated_at ?? source?.static_data_updated_at ?? undefined;
  const realtimeDataUpdatedAt =
    site.realtime_data_updated_at ?? source?.realtime_data_updated_at ?? undefined;
  const dataUpdatedAt =
    realtime.hasRealtime && realtimeDataUpdatedAt ? realtimeDataUpdatedAt : staticDataUpdatedAt;
  const isStale =
    realtime.hasRealtime && isStaleTimestamp(realtimeDataUpdatedAt, REALTIME_STALE_AFTER_MS);
  const qualityWarnings = [...realtime.warnings];
  if (isStale) qualityWarnings.push("Realtime availability is older than 30 minutes.");

  return {
    id: `parkapi-v3:${site.id}`,
    name: site.name,
    coordinates: [lon, lat],
    sources: ["parkapi-v3"],
    sourceUid: site.source_uid,
    sourceName: source?.name,
    sourceUrl: source?.public_url ?? undefined,
    sourceAttribution: normalizeSourceAttribution(source),
    parkingType: mapType(site.type),
    capacity: realtime.capacity,
    freeSpaces: realtime.freeSpaces,
    hasRealtimeData: realtime.hasRealtime,
    dataUpdatedAt,
    staticDataUpdatedAt,
    realtimeDataUpdatedAt,
    isStale: isStale || undefined,
    qualityWarnings: qualityWarnings.length > 0 ? qualityWarnings : undefined,
    disabledSpaces: site.capacity_disabled ?? undefined,
    chargingSpaces: site.capacity_charging ?? undefined,
    maxHeight: site.max_height ?? undefined,
    fee: site.has_fee === true ? "paid" : site.has_fee === false ? "free" : "unknown",
    feeDescription: site.fee_description ?? undefined,
    operator: site.operator_name ?? undefined,
    address: site.address ?? undefined,
    openingHours: site.opening_hours ?? undefined,
    url: site.public_url ?? undefined,
  };
}

async function fetchSources(): Promise<Map<string, ParkApiV3Source>> {
  if (sourceCache && Date.now() - sourceCache.fetchedAt < SOURCE_CACHE_TTL) {
    return sourceCache.sources;
  }

  const res = await fetch(SOURCES_API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    if (sourceCache) return sourceCache.sources;
    return new Map();
  }

  const data = (await res.json()) as { items?: ParkApiV3Source[] } | ParkApiV3Source[];
  const raw = Array.isArray(data) ? data : (data.items ?? []);
  const sources = new Map(raw.map((source) => [source.uid, source]));
  sourceCache = { sources, fetchedAt: Date.now() };
  return sources;
}

async function fetchAllSites(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < LIST_CACHE_TTL) {
    return listCache.sites;
  }

  const res = await fetch(API_BASE, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (listCache) return listCache.sites;
    throw new Error(`ParkAPI v3 failed: ${res.status}`);
  }

  const data = (await res.json()) as { items?: ParkApiV3Site[] } | ParkApiV3Site[];
  const raw = Array.isArray(data) ? data : (data.items ?? []);
  const sources = await fetchSources();

  const sites: ParkingFacility[] = [];
  for (const site of raw) {
    const f = siteToFacility(site, site.source_uid ? sources.get(site.source_uid) : undefined);
    if (f) sites.push(f);
  }

  listCache = { sites, fetchedAt: Date.now() };
  return sites;
}

export async function searchParkApiV3(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allSites = await fetchAllSites();
  return allSites.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchParkApiV3Detail(siteId: number): Promise<ParkingFacility | null> {
  const url = `${API_BASE}/${siteId}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;

  const site = (await res.json()) as ParkApiV3Site;
  const sources = await fetchSources();
  return siteToFacility(site, site.source_uid ? sources.get(site.source_uid) : undefined);
}
