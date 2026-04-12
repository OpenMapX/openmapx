import type { BoundingBox } from "@openmapx/core";
import type { ParkApiV3Site, ParkingFacility, ParkingType } from "./types.js";

const API_BASE = "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites";
const LIST_CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time data refreshes every ~5 min

/** Rough bounding box for Germany + buffer (v3 covers all of DE, not just BW). */
const COVERAGE_BBOX = { south: 45.5, west: 5.5, north: 55.5, east: 15.5 };

let listCache: { sites: ParkingFacility[]; fetchedAt: number } | null = null;

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

function siteToFacility(site: ParkApiV3Site): ParkingFacility | null {
  const lat = site.lat != null ? Number.parseFloat(site.lat) : undefined;
  const lon = site.lon != null ? Number.parseFloat(site.lon) : undefined;
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  const hasRealtime = site.has_realtime_data === true && site.realtime_free_capacity != null;
  return {
    id: `parkapi-v3:${site.id}`,
    name: site.name,
    coordinates: [lon, lat],
    sources: ["parkapi-v3"],
    parkingType: mapType(site.type),
    capacity: site.capacity ?? undefined,
    freeSpaces: hasRealtime ? (site.realtime_free_capacity ?? undefined) : undefined,
    hasRealtimeData: hasRealtime,
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

  const sites: ParkingFacility[] = [];
  for (const site of raw) {
    const f = siteToFacility(site);
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
  return siteToFacility(site);
}
