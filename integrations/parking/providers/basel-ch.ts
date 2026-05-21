import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Basel (Switzerland) real-time parking garage client.
 *
 * Uses the Kanton Basel-Stadt Opendatasoft v2.1 API for real-time parking
 * garage occupancy data. ~20 garages with live availability updates.
 *
 * License: CC BY 4.0. No authentication required.
 */

interface BaselRecord {
  published: string;
  free: number;
  total: number;
  auslastungen: number | null;
  id: string;
  id2: string;
  title: string;
  name: string;
  address: string | null;
  link: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  description: string | null;
}

interface BaselResponse {
  total_count: number;
  results: BaselRecord[];
}

const API_URL = "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100014/records?limit=100";
const CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time data

const COVERAGE_BBOX = { south: 47.52, west: 7.55, north: 47.6, east: 7.65 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function recordToFacility(record: BaselRecord): ParkingFacility | null {
  const lng = record.geo_point_2d?.lon;
  const lat = record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity = record.total > 0 ? record.total : undefined;
  const freeSpaces = record.free != null && record.free >= 0 ? record.free : undefined;

  return {
    id: `basel:${record.id2}`,
    name: record.title || record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["basel-ch"],
    parkingType: "garage" as ParkingType,
    capacity,
    freeSpaces,
    hasRealtimeData: true,
    fee: "paid",
    address: record.address ?? undefined,
    url: record.link ?? undefined,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Basel parking failed: ${res.status}`);
  }

  const data = (await res.json()) as BaselResponse;

  const facilities: ParkingFacility[] = [];
  for (const record of data.results) {
    const facility = recordToFacility(record);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchBaselCh(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchBaselChDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `basel:${id}`) ?? null;
}
