import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "./types.js";

/**
 * Transport for NSW car park client.
 *
 * Provides real-time occupancy for Park & Ride and Sydney Metro car parks
 * in the Greater Sydney area via the TfNSW Open Data Car Park API.
 *
 * Endpoints:
 *   - GET /v1/carpark              → list of facilities (no facility param)
 *   - GET /v1/carpark?facility=ID  → occupancy for a specific facility
 *
 * Auth: API key in Authorization header as "apikey {KEY}".
 * License: CC BY 4.0.
 *
 * Reference:
 *   https://opendata.transport.nsw.gov.au/dataset/car-park-api
 */

// TODO: Verify exact JSON field names with actual API key.
// The field names below are inferred from the Swagger spec, documentation PDF,
// and community usage examples. The list endpoint may return a different shape
// than the facility detail endpoint.

interface NswFacilityListItem {
  facility_id?: string;
  facility_name?: string;
  // TODO: The list endpoint may not include coordinates; verify with credentials.
  // If coordinates are absent in the list, we may need a static lookup table.
  latitude?: number;
  longitude?: number;
  capacity?: number;
  // TODO: The list endpoint might include a "zones" array or "spots" count.
  zones?: NswZone[];
}

interface NswZone {
  zone_id?: string;
  zone_name?: string;
  spots?: number;
  occupancy?: number;
  // TODO: Confirm whether zone-level capacity/occupancy fields exist.
}

interface NswFacilityDetail {
  facility_id?: string;
  facility_name?: string;
  latitude?: number;
  longitude?: number;
  capacity?: number;
  occupancy?: {
    total?: number;
    zones?: NswOccupancyZone[];
  };
  // TODO: Verify whether "spots", "time", "MessageType" or other fields exist.
  spots?: number;
  time?: string;
  MessageType?: string;
  zones?: NswZone[];
}

interface NswOccupancyZone {
  zone_id?: string;
  zone_name?: string;
  spots?: number;
  occupancy?: number;
}

// TODO: Verify whether the list endpoint returns a bare array, a wrapper object,
// or a different structure. Adjust accordingly.
type NswListResponse = NswFacilityListItem[] | { facilities: NswFacilityListItem[] };

const API_BASE = "https://api.transport.nsw.gov.au/v1";

const LIST_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — facility list is mostly static
const OCCUPANCY_CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time occupancy

const COVERAGE_BBOX = { south: -34.2, west: 150.6, north: -33.5, east: 151.4 };

// Known facility IDs with approximate coordinates for Park & Ride / Metro stations.
// Used as fallback when the list endpoint does not include coordinates.
// TODO: Remove this table once the list endpoint is verified to include lat/lng.
const KNOWN_FACILITIES: Record<
  string,
  { name: string; lat: number; lng: number; capacity: number }
> = {
  "2": { name: "Tallawong Station", lat: -33.693, lng: 150.9065, capacity: 1400 },
  "4": { name: "Kellyville Station", lat: -33.7184, lng: 150.9554, capacity: 600 },
  "6": { name: "Hills Showground Station", lat: -33.729, lng: 150.9863, capacity: 300 },
  "8": { name: "Cherrybrook Station", lat: -33.7477, lng: 151.0318, capacity: 400 },
  "10": { name: "Bella Vista Station", lat: -33.7297, lng: 150.9467, capacity: 800 },
  "12": { name: "Gordon Station", lat: -33.7561, lng: 151.1536, capacity: 200 },
  "14": { name: "Ashfield Station", lat: -33.8878, lng: 151.1261, capacity: 100 },
  "16": { name: "Seven Hills Station", lat: -33.7746, lng: 150.9356, capacity: 300 },
  "18": { name: "Kogarah Station", lat: -33.9632, lng: 151.1314, capacity: 100 },
  "20": { name: "Narrabeen", lat: -33.7152, lng: 151.2946, capacity: 80 },
  "22": { name: "Manly Vale", lat: -33.7783, lng: 151.2594, capacity: 100 },
};

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;
const occupancyCache: Map<string, { total: number; fetchedAt: number }> = new Map();

// Populated by setup(ctx) from the resolved integration config cascade.
let cachedApiKey: string | undefined;
export function setNswTransportApiKey(value: string | undefined): void {
  cachedApiKey = value && value.length > 0 ? value : undefined;
}

function getApiKey(): string | null {
  return cachedApiKey ?? null;
}

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `apikey ${apiKey}`,
    Accept: "application/json",
  };
}

function listItemToFacility(item: NswFacilityListItem): ParkingFacility | null {
  const facilityId = item.facility_id ?? "";
  if (!facilityId) return null;

  let lat = item.latitude;
  let lng = item.longitude;
  let name = item.facility_name || `Car Park ${facilityId}`;
  let capacity = item.capacity;

  // Fallback to known facilities table if coordinates are missing
  if (lat == null || lng == null) {
    const known = KNOWN_FACILITIES[facilityId];
    if (!known) return null;
    lat = known.lat;
    lng = known.lng;
    name = item.facility_name || known.name;
    capacity = capacity ?? known.capacity;
  }

  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  // Compute total capacity from zones if top-level capacity is missing
  if (capacity == null && item.zones) {
    let zoneTotal = 0;
    for (const z of item.zones) {
      if (z.spots != null) zoneTotal += z.spots;
    }
    if (zoneTotal > 0) capacity = zoneTotal;
  }

  // Check cached occupancy
  const cachedOcc = occupancyCache.get(facilityId);
  const hasCachedOccupancy = cachedOcc && Date.now() - cachedOcc.fetchedAt < OCCUPANCY_CACHE_TTL;
  const occupied = hasCachedOccupancy ? cachedOcc.total : undefined;
  const freeSpaces =
    occupied != null && capacity != null ? Math.max(0, capacity - occupied) : undefined;

  return {
    id: `nsw:${facilityId}`,
    name,
    coordinates: [lng, lat],
    sources: ["nsw-au"],
    parkingType: "surface" as ParkingType, // Park & Ride lots are typically surface
    capacity: capacity != null && capacity > 0 ? capacity : undefined,
    freeSpaces,
    hasRealtimeData: hasCachedOccupancy ?? false,
    fee: "free", // Park & Ride is generally free
    parkAndRide: true,
  };
}

async function fetchFacilityList(apiKey: string): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < LIST_CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(`${API_BASE}/carpark`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    return [];
  }

  const data = (await res.json()) as NswListResponse;
  const items = Array.isArray(data) ? data : (data.facilities ?? []);

  const facilities: ParkingFacility[] = [];
  for (const item of items) {
    const facility = listItemToFacility(item);
    if (facility) facilities.push(facility);
  }

  // If the list endpoint returned no parseable facilities, fall back to known list
  if (facilities.length === 0) {
    for (const [fid, known] of Object.entries(KNOWN_FACILITIES)) {
      facilities.push({
        id: `nsw:${fid}`,
        name: known.name,
        coordinates: [known.lng, known.lat],
        sources: ["nsw-au"],
        parkingType: "surface",
        capacity: known.capacity,
        hasRealtimeData: false,
        fee: "free",
        parkAndRide: true,
      });
    }
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

async function fetchOccupancy(apiKey: string, facilityId: string): Promise<number | null> {
  const cached = occupancyCache.get(facilityId);
  if (cached && Date.now() - cached.fetchedAt < OCCUPANCY_CACHE_TTL) {
    return cached.total;
  }

  try {
    const res = await fetch(`${API_BASE}/carpark?facility=${encodeURIComponent(facilityId)}`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as NswFacilityDetail;

    // The occupancy may be nested under an "occupancy" object or at the top level
    // TODO: Verify the exact response shape with credentials
    const total = data.occupancy?.total ?? data.spots ?? null;
    if (total != null) {
      occupancyCache.set(facilityId, { total, fetchedAt: Date.now() });
    }

    return total;
  } catch {
    return null;
  }
}

async function fetchOccupancyBatch(apiKey: string, facilityIds: string[]): Promise<void> {
  // Fetch occupancy for all facilities in parallel (limited concurrency)
  const BATCH_SIZE = 5;
  for (let i = 0; i < facilityIds.length; i += BATCH_SIZE) {
    const batch = facilityIds.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map((id) => fetchOccupancy(apiKey, id)));
  }
}

export async function searchNswAu(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const apiKey = getApiKey();
  if (!apiKey) return [];
  const allFacilities = await fetchFacilityList(apiKey);

  // Filter to bbox
  const inBbox = allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });

  // Fetch live occupancy for visible facilities
  const facilityIds = inBbox.map((f) => f.id.slice("nsw:".length));
  await fetchOccupancyBatch(apiKey, facilityIds);

  // Re-map with updated occupancy data
  return inBbox.map((f) => {
    const fid = f.id.slice("nsw:".length);
    const cached = occupancyCache.get(fid);
    const hasCachedOccupancy = cached && Date.now() - cached.fetchedAt < OCCUPANCY_CACHE_TTL;

    if (hasCachedOccupancy && f.capacity) {
      return {
        ...f,
        freeSpaces: Math.max(0, f.capacity - cached.total),
        hasRealtimeData: true,
      };
    }
    return f;
  });
}

export async function fetchNswAuDetail(facilityId: string): Promise<ParkingFacility | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  const allFacilities = await fetchFacilityList(apiKey);

  const facility = allFacilities.find((f) => f.id === `nsw:${facilityId}`);
  if (!facility) return null;

  // Fetch fresh occupancy for this specific facility
  const total = await fetchOccupancy(apiKey, facilityId);

  if (total != null && facility.capacity) {
    return {
      ...facility,
      freeSpaces: Math.max(0, facility.capacity - total),
      hasRealtimeData: true,
    };
  }

  return facility;
}
