import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";

/**
 * Barcelona parking facilities client.
 *
 * Uses the Ajuntament de Barcelona open-data registry of parking locations
 * (~556 facilities). Static data with no real-time availability information.
 *
 * License: CC BY 4.0. No authentication required.
 */

const API_URL =
  "https://opendata-ajuntament.barcelona.cat/data/dataset/a8b29664-ab16-4341-9460-33f60d048d82/resource/3ed73d45-8ea6-4cdf-8984-11a4c4cfc9e8/download";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 41.32, west: 2.05, north: 41.47, east: 2.23 };

interface BarcelonaGeometry {
  type: string;
  geometries?: Array<{
    type: string;
    coordinates: [number, number];
  }>;
}

interface BarcelonaAddress {
  district_name?: string;
  neighborhood_name?: string;
  address_name?: string;
  start_street_number?: number | null;
  zip_code?: string;
  town?: string;
  location_4326?: BarcelonaGeometry;
}

interface BarcelonaRecord {
  register_id: number;
  name: string;
  status_name?: string;
  addresses?: BarcelonaAddress[];
  classifications_data?: Array<{
    name: string;
    full_path: string;
  }>;
  attribute_categories?: Array<{
    name: string;
    attributes: Array<{
      name: string;
      values: Array<{
        value: string;
      }>;
    }>;
  }>;
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

function extractCoordinates(address: BarcelonaAddress): [number, number] | null {
  const geom = address.location_4326;
  if (!geom?.geometries?.length) return null;

  const point = geom.geometries.find((g) => g.type === "Point");
  if (!point?.coordinates) return null;

  // location_4326 uses [lat, lng] order
  const [lat, lng] = point.coordinates;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  return [lng, lat];
}

function buildAddress(addr: BarcelonaAddress): string | undefined {
  const parts: string[] = [];
  if (addr.address_name) {
    let street = addr.address_name;
    if (addr.start_street_number != null) {
      street += ` ${addr.start_street_number}`;
    }
    parts.push(street);
  }
  if (addr.zip_code && addr.town) {
    parts.push(`${addr.zip_code} ${addr.town}`);
  } else if (addr.town) {
    parts.push(addr.town);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractPhone(record: BarcelonaRecord): string | undefined {
  if (!record.attribute_categories) return undefined;
  for (const cat of record.attribute_categories) {
    for (const attr of cat.attributes) {
      if (attr.name === "Tel." && attr.values?.length > 0) {
        return attr.values[0].value;
      }
    }
  }
  return undefined;
}

function recordToFacility(record: BarcelonaRecord): ParkingFacility | null {
  const address = record.addresses?.[0];
  if (!address) return null;

  const coords = extractCoordinates(address);
  if (!coords) return null;

  const phone = extractPhone(record);
  const streetAddress = buildAddress(address);

  // Build fee description from phone if available
  const feeDescription = phone ? `Tel: ${phone}` : undefined;

  return {
    id: `barcelona:${record.register_id}`,
    name: record.name || "Parking",
    coordinates: coords,
    sources: ["barcelona-es"],
    parkingType: "garage",
    hasRealtimeData: false,
    fee: "paid",
    feeDescription,
    access: "public",
    address: streetAddress,
    state: record.status_name === "Publicat" ? "open" : "unknown",
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Barcelona parking failed: ${res.status}`);
  }

  const data = (await res.json()) as BarcelonaRecord[];

  const facilities: ParkingFacility[] = [];
  for (const record of data) {
    const facility = recordToFacility(record);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchBarcelonaEs(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchBarcelonaEsDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `barcelona:${id}`) ?? null;
}
