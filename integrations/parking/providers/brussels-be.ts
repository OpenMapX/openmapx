import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Brussels (Belgium) public parking client.
 *
 * Uses the Open Data Brussels Opendatasoft v2.1 API for static parking
 * facility information. No real-time availability data.
 *
 * License: CC0 1.0. No authentication required.
 */

interface BrusselsRecord {
  name_fr: string | null;
  name_nl: string | null;
  adressee: string | null;
  adres_: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  operator_fr: string | null;
  contact_mail: string | null;
  contact_phone: string | null;
  capacity: number | null;
  disabledcapacity: number | null;
  floors: number | null;
  maxwidth: number | null;
  maxheight: number | null;
  commune_gemeente: string | null;
}

interface BrusselsResponse {
  total_count: number;
  results: BrusselsRecord[];
}

const API_URL =
  "https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bruxelles_parkings_publics/records?limit=100";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 50.78, west: 4.25, north: 50.92, east: 4.48 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function parseMaxHeight(value: number | null): number | undefined {
  if (value == null || value <= 0) return undefined;
  // Values < 10 are meters, >= 10 are already centimeters
  return value < 10 ? Math.round(value * 100) : Math.round(value);
}

function deriveParkingType(record: BrusselsRecord): ParkingType {
  if (record.floors != null && record.floors > 1) return "garage";
  return "garage";
}

function recordToFacility(record: BrusselsRecord): ParkingFacility | null {
  const lng = record.geo_point_2d?.lon;
  const lat = record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const name = record.name_fr || record.name_nl || "Parking";
  const capacity = record.capacity != null && record.capacity > 0 ? record.capacity : undefined;
  const disabledSpaces =
    record.disabledcapacity != null && record.disabledcapacity > 0
      ? record.disabledcapacity
      : undefined;
  const maxHeight = parseMaxHeight(record.maxheight);

  return {
    id: `brussels:${name}`,
    name,
    coordinates: [lng, lat],
    sources: ["brussels-be"],
    parkingType: deriveParkingType(record),
    capacity,
    hasRealtimeData: false,
    disabledSpaces,
    maxHeight,
    fee: "unknown",
    operator: record.operator_fr ?? undefined,
    address: record.adressee ?? undefined,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Brussels parking failed: ${res.status}`);
  }

  const data = (await res.json()) as BrusselsResponse;

  const facilities: ParkingFacility[] = [];
  for (const record of data.results) {
    const facility = recordToFacility(record);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchBrusselsBe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchBrusselsBeDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `brussels:${id}`) ?? null;
}
