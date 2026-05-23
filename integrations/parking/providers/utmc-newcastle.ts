import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * UTMC (Urban Traffic Management and Control) Tyne & Wear parking client.
 *
 * Provides real-time car park occupancy for car parks in the Newcastle /
 * Tyne & Wear area via the NE Travel Data open data service.
 *
 * Two feeds:
 *   - Static  (/api/v2/carpark/static):  name, location, capacity (~24h refresh)
 *   - Dynamic (/api/v2/carpark/dynamic): live occupancy + state (~60s refresh)
 *
 * Auth: HTTP Basic (username + password).
 * License: OGL v3.
 *
 * Per Tyne and Wear Open Data Services Platform API Specification
 * (Mott MacDonald, October 2019). The authoritative samples in sections 5.4
 * and 6.4 of that document are the source of the shapes below.
 */

interface UtmcStaticCarPark {
  systemCodeNumber: string;
  /** Typically one element per car park, per spec section 5. */
  definitions: Array<{
    shortDescription?: string;
    longDescription?: string;
    point?: {
      easting?: number;
      northing?: number;
      latitude?: number;
      longitude?: number;
    };
    lastUpdated?: string;
  }>;
  /** Typically one element per car park, per spec section 5. */
  configurations: Array<{
    capacity?: number;
    configurationDate?: string;
  }>;
}

type UtmcState = "SPACES" | "ALMOST FULL" | "FULL" | "OPEN" | "CLOSED" | "UNKNOWN" | "FAULTY";

interface UtmcDynamicCarPark {
  systemCodeNumber: string;
  /** Typically one element per car park, per spec section 6. */
  dynamics: Array<{
    occupancy?: number;
    stateDescription?: UtmcState;
    lastUpdated?: string;
  }>;
}

const STATIC_API = "https://www.netraveldata.co.uk/api/v2/carpark/static";
const DYNAMIC_API = "https://www.netraveldata.co.uk/api/v2/carpark/dynamic";

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

function mapState(stateDescription?: UtmcState | string): "open" | "closed" | "unknown" {
  if (!stateDescription) return "unknown";
  const upper = stateDescription.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "FAULTY") return "closed";
  if (upper === "SPACES" || upper === "ALMOST FULL" || upper === "FULL" || upper === "OPEN") {
    return "open";
  }
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

/**
 * Build a ParkingFacility from one static + (optionally) one dynamic record.
 *
 * Per Tyne and Wear Open Data Services Platform API Specification
 * (Mott MacDonald, October 2019), `definitions`, `configurations`, and
 * `dynamics` are all arrays — sections 5.4 and 6.4 show one element per
 * car park as the typical case, and we take the first.
 */
export function staticToFacility(
  record: UtmcStaticCarPark,
  dynamic?: UtmcDynamicCarPark,
): ParkingFacility | null {
  const def = record.definitions?.[0];
  const cfg = record.configurations?.[0];
  if (!def) return null;

  const lat = def.point?.latitude;
  const lng = def.point?.longitude;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const capacity = cfg?.capacity;
  const dyn = dynamic?.dynamics?.[0];
  const occupancy = dyn?.occupancy;
  const freeSpaces = deriveFreeSpaces(occupancy, capacity);
  const hasDynamic = dyn != null && occupancy != null;

  return {
    id: `utmc:${record.systemCodeNumber}`,
    name: def.shortDescription || `Car Park ${record.systemCodeNumber}`,
    coordinates: [lng, lat],
    sources: ["utmc-newcastle"],
    parkingType: "garage" as ParkingType,
    capacity: capacity != null && capacity > 0 ? capacity : undefined,
    freeSpaces,
    hasRealtimeData: hasDynamic,
    dataUpdatedAt: dyn?.lastUpdated ?? def.lastUpdated,
    staticDataUpdatedAt: def.lastUpdated,
    realtimeDataUpdatedAt: hasDynamic ? dyn?.lastUpdated : undefined,
    fee: "unknown",
    address: def.longDescription ?? undefined,
    state: hasDynamic ? mapState(dyn?.stateDescription) : "unknown",
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

  // Per spec section 5.4: the response is always a bare JSON array.
  const data = (await res.json()) as UtmcStaticCarPark[];
  const carParks = Array.isArray(data) ? data : [];
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

  // Per spec section 6.4: the response is always a bare JSON array.
  const data = (await res.json()) as UtmcDynamicCarPark[];
  const records = Array.isArray(data) ? data : [];
  const map = new Map<string, UtmcDynamicCarPark>();
  for (const r of records) {
    if (r?.systemCodeNumber) map.set(r.systemCodeNumber, r);
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
    if (!record?.definitions?.length) {
      console.warn(`[utmc-newcastle] skipping ${record?.systemCodeNumber}: empty definitions`);
      continue;
    }
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
