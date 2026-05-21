import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Ghent (Belgium) real-time parking garage client.
 *
 * Uses the Stad Gent Opendatasoft v2.1 API for real-time parking garage
 * occupancy data. ~10 garages with live availability updates.
 *
 * License: Modellicentie Gratis Hergebruik. No authentication required.
 */

interface GhentRecord {
  name: string;
  lastupdate: string;
  totalcapacity: number;
  availablecapacity: number;
  occupation: number;
  type: string;
  description: string | null;
  id: string;
  openingtimesdescription: string | null;
  isopennow: number;
  temporaryclosed: number;
  operatorinformation: string | null;
  freeparking: number;
  urllinkaddress: string | null;
  occupancytrend: string | null;
  location: { lon: number; lat: number } | null;
  categorie: string | null;
}

interface GhentResponse {
  total_count: number;
  results: GhentRecord[];
}

const API_URL =
  "https://data.stad.gent/api/explore/v2.1/catalog/datasets/bezetting-parkeergarages-real-time/records?limit=100";
const CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time data

const COVERAGE_BBOX = { south: 50.95, west: 3.6, north: 51.15, east: 3.85 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function deriveState(record: GhentRecord): "open" | "closed" | "unknown" {
  if (record.temporaryclosed === 1) return "closed";
  if (record.isopennow === 1) return "open";
  return "unknown";
}

function recordToFacility(record: GhentRecord): ParkingFacility | null {
  const lng = record.location?.lon;
  const lat = record.location?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity = record.totalcapacity > 0 ? record.totalcapacity : undefined;
  const freeSpaces =
    record.availablecapacity != null && record.availablecapacity >= 0
      ? record.availablecapacity
      : undefined;

  return {
    id: `ghent:${record.name}`,
    name: record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["ghent-be"],
    parkingType: "garage" as ParkingType,
    capacity,
    freeSpaces,
    hasRealtimeData: true,
    fee: record.freeparking === 1 ? "free" : "paid",
    operator: record.operatorinformation ?? undefined,
    openingHours: record.openingtimesdescription ?? undefined,
    state: deriveState(record),
    url: record.urllinkaddress ?? undefined,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Ghent parking failed: ${res.status}`);
  }

  const data = (await res.json()) as GhentResponse;

  const facilities: ParkingFacility[] = [];
  for (const record of data.results) {
    const facility = recordToFacility(record);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchGhentBe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchGhentBeDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `ghent:${id}`) ?? null;
}
