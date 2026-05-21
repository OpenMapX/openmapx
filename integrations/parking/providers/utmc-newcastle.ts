import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * UTMC (Urban Traffic Management and Control) Tyne & Wear parking client.
 *
 * Provides real-time car park occupancy for ~16 car parks in the
 * Newcastle / Tyne & Wear area via the NE Travel Data open data service.
 *
 * Two feeds:
 *   - Static: name, location, capacity (refreshed every 24h)
 *   - Dynamic: live occupancy + state (refreshed every ~60s, cached 2 min)
 *
 * Auth: username + password sent as Basic auth header.
 * License: OGL v3.
 */

// TODO: Verify exact JSON field names with actual API credentials.
// The field names below are based on the published API specification
// (https://www.netraveldata.co.uk/?page_id=32) and may need adjustment.

interface UtmcStaticCarPark {
  systemCodeNumber: string;
  definitions: {
    shortDescription?: string;
    longDescription?: string;
    point?: {
      easting?: number;
      northing?: number;
      latitude?: number;
      longitude?: number;
    };
    lastUpdated?: string;
  };
  configurations?: {
    capacity?: number;
    configurationDate?: string;
  };
}

interface UtmcDynamicCarPark {
  systemCodeNumber: string;
  dynamics: {
    occupancy?: number;
    stateDescription?: string; // SPACES | ALMOST FULL | FULL | OPEN | CLOSED | UNKNOWN | FAULTY
    lastUpdated?: string;
  };
}

// TODO: The top-level response wrapper may differ — verify whether the API
// returns a bare array or an object with a property (e.g. { carParks: [...] }).
type UtmcStaticResponse = UtmcStaticCarPark[] | { carParks: UtmcStaticCarPark[] };
type UtmcDynamicResponse = UtmcDynamicCarPark[] | { carParks: UtmcDynamicCarPark[] };

const STATIC_API = "https://www.netraveldata.co.uk/api/v1/carpark/static";
const DYNAMIC_API = "https://www.netraveldata.co.uk/api/v1/carpark/dynamic";

const STATIC_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const DYNAMIC_CACHE_TTL = 2 * 60 * 1000; // 2 min

const COVERAGE_BBOX = { south: 54.85, west: -1.8, north: 55.1, east: -1.4 };

let staticCache: { carParks: UtmcStaticCarPark[]; fetchedAt: number } | null = null;
let dynamicCache: { carParks: Map<string, UtmcDynamicCarPark>; fetchedAt: number } | null = null;

// Populated by setup(ctx) from the resolved integration config cascade.
let cachedUsername: string | undefined;
let cachedPassword: string | undefined;

export function setUtmcCredentials(creds: { username?: string; password?: string }): void {
  cachedUsername = creds.username && creds.username.length > 0 ? creds.username : undefined;
  cachedPassword = creds.password && creds.password.length > 0 ? creds.password : undefined;
}

function getCredentials(): { username: string; password: string } | null {
  if (!cachedUsername || !cachedPassword) return null;
  return { username: cachedUsername, password: cachedPassword };
}

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function authHeaders(creds: { username: string; password: string }): Record<string, string> {
  const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
  };
}

function unwrapStatic(data: UtmcStaticResponse): UtmcStaticCarPark[] {
  return Array.isArray(data) ? data : (data.carParks ?? []);
}

function unwrapDynamic(data: UtmcDynamicResponse): UtmcDynamicCarPark[] {
  return Array.isArray(data) ? data : (data.carParks ?? []);
}

function mapState(stateDescription?: string): "open" | "closed" | "unknown" {
  if (!stateDescription) return "unknown";
  const upper = stateDescription.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "FAULTY") return "closed";
  if (["SPACES", "ALMOST FULL", "FULL", "OPEN"].includes(upper)) return "open";
  return "unknown";
}

function deriveFreeSpaces(
  occupancy: number | undefined,
  capacity: number | undefined,
): number | undefined {
  if (occupancy == null || capacity == null) return undefined;
  const free = capacity - occupancy;
  return free >= 0 ? free : 0;
}

function staticToFacility(
  record: UtmcStaticCarPark,
  dynamic?: UtmcDynamicCarPark,
): ParkingFacility | null {
  const lat = record.definitions?.point?.latitude;
  const lng = record.definitions?.point?.longitude;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity = record.configurations?.capacity;
  const occupancy = dynamic?.dynamics?.occupancy;
  const freeSpaces = deriveFreeSpaces(occupancy, capacity);
  const hasDynamic = dynamic != null && occupancy != null;

  return {
    id: `utmc:${record.systemCodeNumber}`,
    name: record.definitions?.shortDescription || `Car Park ${record.systemCodeNumber}`,
    coordinates: [lng, lat],
    sources: ["utmc-newcastle"],
    parkingType: "garage" as ParkingType,
    capacity: capacity != null && capacity > 0 ? capacity : undefined,
    freeSpaces,
    hasRealtimeData: hasDynamic,
    fee: "unknown",
    address: record.definitions?.longDescription ?? undefined,
    state: hasDynamic ? mapState(dynamic.dynamics?.stateDescription) : "unknown",
  };
}

async function fetchStatic(creds: {
  username: string;
  password: string;
}): Promise<UtmcStaticCarPark[]> {
  if (staticCache && Date.now() - staticCache.fetchedAt < STATIC_CACHE_TTL) {
    return staticCache.carParks;
  }

  const res = await fetch(STATIC_API, {
    headers: authHeaders(creds),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (staticCache) return staticCache.carParks;
    return [];
  }

  const data = (await res.json()) as UtmcStaticResponse;
  const carParks = unwrapStatic(data);
  staticCache = { carParks, fetchedAt: Date.now() };
  return carParks;
}

async function fetchDynamic(creds: {
  username: string;
  password: string;
}): Promise<Map<string, UtmcDynamicCarPark>> {
  if (dynamicCache && Date.now() - dynamicCache.fetchedAt < DYNAMIC_CACHE_TTL) {
    return dynamicCache.carParks;
  }

  const res = await fetch(DYNAMIC_API, {
    headers: authHeaders(creds),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    if (dynamicCache) return dynamicCache.carParks;
    return new Map();
  }

  const data = (await res.json()) as UtmcDynamicResponse;
  const records = unwrapDynamic(data);
  const map = new Map<string, UtmcDynamicCarPark>();
  for (const r of records) {
    map.set(r.systemCodeNumber, r);
  }

  dynamicCache = { carParks: map, fetchedAt: Date.now() };
  return map;
}

export async function searchUtmcNewcastle(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const creds = getCredentials();
  if (!creds) return [];
  const [staticResult, dynamicResult] = await Promise.allSettled([
    fetchStatic(creds),
    fetchDynamic(creds),
  ]);

  const statics = staticResult.status === "fulfilled" ? staticResult.value : [];
  const dynamics =
    dynamicResult.status === "fulfilled"
      ? dynamicResult.value
      : new Map<string, UtmcDynamicCarPark>();

  const facilities: ParkingFacility[] = [];
  for (const record of statics) {
    const dynamic = dynamics.get(record.systemCodeNumber);
    const facility = staticToFacility(record, dynamic);
    if (!facility) continue;

    const [lng, lat] = facility.coordinates;
    if (lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east) {
      facilities.push(facility);
    }
  }

  return facilities;
}

export async function fetchUtmcNewcastleDetail(id: string): Promise<ParkingFacility | null> {
  const creds = getCredentials();
  if (!creds) return null;
  const [staticResult, dynamicResult] = await Promise.allSettled([
    fetchStatic(creds),
    fetchDynamic(creds),
  ]);

  const statics = staticResult.status === "fulfilled" ? staticResult.value : [];
  const dynamics =
    dynamicResult.status === "fulfilled"
      ? dynamicResult.value
      : new Map<string, UtmcDynamicCarPark>();

  const record = statics.find((r) => r.systemCodeNumber === id);
  if (!record) return null;

  const dynamic = dynamics.get(id);
  return staticToFacility(record, dynamic);
}
