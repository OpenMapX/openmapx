import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility } from "./types.js";

/**
 * Florence (Firenze) real-time parking availability client.
 *
 * Uses the Comune di Firenze open-data endpoint which returns current
 * free-spot counts for structured parking facilities across the city.
 * ~20 facilities with real-time FreeSpot data updated every few minutes.
 *
 * License: Open Data. No authentication required.
 */

const API_URL = "https://datastore.comune.fi.it/od/ParkFreeSpot.json";
const CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time data

const COVERAGE_BBOX = { south: 43.72, west: 11.18, north: 43.82, east: 11.32 };

interface FlorenceRawRecord {
  Id: string;
  Name: string;
  FreeSpot: string;
  UpdateDate: string;
  Latitude: string;
  Longitude: string;
}

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function recordToFacility(record: FlorenceRawRecord): ParkingFacility | null {
  const lat = Number.parseFloat(record.Latitude);
  const lng = Number.parseFloat(record.Longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const freeSpaces = Number.parseInt(record.FreeSpot, 10);

  return {
    id: `florence:${record.Id}`,
    name: record.Name || "Parking",
    coordinates: [lng, lat],
    sources: ["florence-it"],
    parkingType: "garage",
    freeSpaces: !Number.isNaN(freeSpaces) && freeSpaces >= 0 ? freeSpaces : undefined,
    hasRealtimeData: true,
    fee: "paid",
    access: "public",
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Florence parking failed: ${res.status}`);
  }

  const data = (await res.json()) as FlorenceRawRecord[];

  const facilities: ParkingFacility[] = [];
  for (const record of data) {
    const facility = recordToFacility(record);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchFlorenceIt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchFlorenceItDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `florence:${id}`) ?? null;
}
