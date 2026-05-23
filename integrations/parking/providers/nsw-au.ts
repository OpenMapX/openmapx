import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Transport for NSW car park client.
 *
 * Provides real-time occupancy for Park & Ride and Sydney Metro car parks
 * in the Greater Sydney area via the TfNSW Open Data Car Park API.
 *
 * Endpoints:
 *   - GET /v1/carpark              -> bare array of { facility_id, facility_name }
 *   - GET /v1/carpark?facility=ID  -> single facility detail object (see NswFacilityDetail)
 *
 * Auth: API key in Authorization header as "apikey {KEY}".
 * License: CC BY 4.0.
 *
 * Per TfNSW Car Park API documentation v2.3 (December 2025).
 * Reference: https://opendata.transport.nsw.gov.au/dataset/car-park-api
 */

/** List endpoint entry — bare array of these objects per spec section 2.1. */
interface NswFacilityListEntry {
  facility_id: string;
  facility_name: string;
}

/**
 * Zone object inside the detail response.
 * Per spec section 2.1.5: all numeric-looking fields are returned as strings,
 * and the occupancy counters may be null.
 */
interface NswZone {
  spots: string;
  zone_id: string;
  zone_name: string;
  parent_zone_id: string;
  occupancy: {
    loop: string | null;
    total: string | null;
    monthlies: string | null;
    open_gate: string | null;
    transients: string | null;
  };
}

/**
 * Detail endpoint response shape per spec section 2.1.5 (Sample feed).
 * All numeric fields are strings; `location` and per-facility coordinates
 * were added July 2024 and are present on every detail response.
 */
interface NswFacilityDetail {
  tsn: string;
  /** Per spec: "Please do not use this field. Instead, use MessageDate". */
  time: string;
  spots: string;
  zones: NswZone[];
  ParkID: string;
  location: {
    suburb: string;
    address: string;
    latitude: string;
    longitude: string;
  };
  occupancy: {
    loop: string | null;
    total: string | null;
    monthlies: string | null;
    open_gate: string | null;
    transients: string | null;
  };
  /** Authoritative feed timestamp (ISO 8601, naive local). */
  MessageDate: string;
  facility_id: string;
  facility_name: string;
  tfnsw_facility_id: string;
}

const API_BASE = "https://api.transport.nsw.gov.au/v1";

const LIST_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — facility list is mostly static
const OCCUPANCY_CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time occupancy

const COVERAGE_BBOX = { south: -34.8, west: 150.6, north: -33.4, east: 151.4 };

interface KnownFacility {
  name: string;
  lat: number;
  lng: number;
  capacity: number;
}

/**
 * Static lookup of all 44 facilities published in the TfNSW Car Park API
 * documentation v2.3, section 4 ("Car Parks"). Coordinates are the TSN
 * (station) coordinates from the documentation; the per-facility detail
 * endpoint returns the actual car-park-entrance coordinates in `location`
 * and overrides this fallback when fetched.
 *
 * "Number of spots" values from the table are documented as approximate
 * ("Do not hard code these figures as they may change from time to time")
 * but are used as a static-only capacity fallback; the detail endpoint's
 * `spots` field overrides this whenever a fresh poll has occurred.
 */
const KNOWN_FACILITIES: Record<string, KnownFacility> = {
  // Rows 1-5: historical-only legacy entries (per spec these are still
  // returned by the list endpoint).
  "1": { name: "Tallawong Station Car Park", lat: -33.69163, lng: 150.906022, capacity: 1004 },
  "2": { name: "Kellyville Station Car Park", lat: -33.713514, lng: 150.935304, capacity: 1374 },
  "3": { name: "Bella Vista Station Car Park", lat: -33.730592, lng: 150.944024, capacity: 800 },
  "4": {
    name: "Hills Showground Station Car Park",
    lat: -33.72782,
    lng: 150.987345,
    capacity: 600,
  },
  "5": { name: "Cherrybrook Station Car Park", lat: -33.736703, lng: 151.031977, capacity: 400 },
  // Rows 6-39: active Park&Ride facilities.
  "6": {
    name: "Park&Ride - Gordon Henry St (north)",
    lat: -33.756009,
    lng: 151.154528,
    capacity: 213,
  },
  "7": { name: "Park&Ride - Kiama", lat: -34.672518, lng: 150.854695, capacity: 42 },
  "8": { name: "Park&Ride - Gosford", lat: -33.423883, lng: 151.341711, capacity: 1057 },
  "9": { name: "Park&Ride - Revesby", lat: -33.95246, lng: 151.014838, capacity: 934 },
  // Row 10 PDF prints latitude without sign (33.697777); corrected to the
  // negative-southern-hemisphere value consistent with the address.
  "10": { name: "Park&Ride - Warriewood", lat: -33.697777, lng: 151.300667, capacity: 244 },
  "11": { name: "Park&Ride - Narrabeen", lat: -33.713514, lng: 151.297315, capacity: 46 },
  "12": { name: "Park&Ride - Mona Vale", lat: -33.677276, lng: 151.305146, capacity: 68 },
  "13": { name: "Park&Ride - Dee Why", lat: -33.752797, lng: 151.286485, capacity: 117 },
  "14": { name: "Park&Ride - West Ryde", lat: -33.807172, lng: 151.090229, capacity: 151 },
  "15": {
    name: "Park&Ride - Sutherland East Parade",
    lat: -34.031787,
    lng: 151.05719,
    capacity: 373,
  },
  "16": { name: "Park&Ride - Leppington", lat: -33.9544, lng: 150.8081, capacity: 1884 },
  "17": {
    name: "Park&Ride - Edmondson Park (south)",
    lat: -33.9693,
    lng: 150.8587,
    capacity: 1431,
  },
  "18": { name: "Park&Ride - St Marys", lat: -33.762256, lng: 150.776029, capacity: 682 },
  "19": {
    name: "Park&Ride - Campbelltown Farrow Rd (north)",
    lat: -34.063835,
    lng: 150.813929,
    capacity: 68,
  },
  "20": {
    name: "Park&Ride - Campbelltown Hurley St",
    lat: -34.063835,
    lng: 150.813929,
    capacity: 118,
  },
  "21": { name: "Park&Ride - Penrith (at-grade)", lat: -33.750055, lng: 150.696135, capacity: 230 },
  "22": {
    name: "Park&Ride - Penrith (multi-level)",
    lat: -33.750055,
    lng: 150.696135,
    capacity: 1144,
  },
  "23": { name: "Park&Ride - Warwick Farm", lat: -33.91345, lng: 150.935036, capacity: 910 },
  "24": { name: "Park&Ride - Schofields", lat: -33.704477, lng: 150.873817, capacity: 700 },
  "25": { name: "Park&Ride - Hornsby", lat: -33.702801, lng: 151.098494, capacity: 145 },
  "26": { name: "Park&Ride - Tallawong P1", lat: -33.69163, lng: 150.906022, capacity: 121 },
  "27": { name: "Park&Ride - Tallawong P2", lat: -33.69163, lng: 150.906022, capacity: 455 },
  "28": { name: "Park&Ride - Tallawong P3", lat: -33.69163, lng: 150.906022, capacity: 397 },
  "29": { name: "Park&Ride - Kellyville (north)", lat: -33.713514, lng: 150.935304, capacity: 351 },
  "30": { name: "Park&Ride - Kellyville (south)", lat: -33.713514, lng: 150.935304, capacity: 964 },
  "31": { name: "Park&Ride - Bella Vista", lat: -33.730592, lng: 150.944024, capacity: 777 },
  "32": { name: "Park&Ride - Hills Showground", lat: -33.72782, lng: 150.987345, capacity: 584 },
  "33": { name: "Park&Ride - Cherrybrook", lat: -33.736703, lng: 151.031977, capacity: 384 },
  "34": {
    name: "Park&Ride - Lindfield Village Green",
    lat: -33.775185,
    lng: 151.169111,
    capacity: 94,
  },
  "35": { name: "Park&Ride - Beverly Hills", lat: -33.948849, lng: 151.081692, capacity: 200 },
  "36": { name: "Park&Ride - Emu Plains", lat: -33.745527, lng: 150.66987, capacity: 751 },
  "37": { name: "Park&Ride - Riverwood", lat: -33.952727, lng: 151.050035, capacity: 142 },
  "38": { name: "Park&Ride - North Rocks", lat: -33.765539, lng: 151.014131, capacity: 139 },
  "39": {
    name: "Park&Ride - Edmondson Park (north)",
    lat: -33.969123,
    lng: 150.861594,
    capacity: 917,
  },
  // Rows 486-490: non-sequential IDs per spec.
  "486": { name: "Park&Ride - Ashfield", lat: -33.8875506079, lng: 151.125504163, capacity: 225 },
  "487": { name: "Park&Ride - Kogarah", lat: -33.9621493059, lng: 151.132641462, capacity: 259 },
  "488": {
    name: "Park&Ride - Seven Hills",
    lat: -33.774430434,
    lng: 150.936513359,
    capacity: 1613,
  },
  // ID 489 (Manly Vale) uses a synthetic parent stop TSN 2093117 per the
  // spec note ("not associated with a station, ferry wharf or light rail stop").
  "489": { name: "Park&Ride - Manly Vale", lat: -33.786247, lng: 151.26671, capacity: 142 },
  "490": { name: "Park&Ride - Brookvale", lat: -33.767508, lng: 151.268541, capacity: 246 },
};

interface CachedDetail {
  detail: NswFacilityDetail;
  fetchedAt: number;
}

let listCache: { entries: NswFacilityListEntry[]; fetchedAt: number } | null = null;
const detailCache: Map<string, CachedDetail> = new Map();

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

function parseIntStrict(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a ParkingFacility from a list entry + the static KNOWN_FACILITIES
 * fallback, optionally enriched with a cached detail response.
 *
 * Per TfNSW Car Park API documentation v2.3 (December 2025):
 *   - List endpoint returns only { facility_id, facility_name }; coordinates
 *     and capacity come from the static table or from the detail response.
 *   - Detail endpoint's `spots` is authoritative capacity; `occupancy.total`
 *     is authoritative vehicle count. Availability = spots - total.
 *   - `MessageDate` is the authoritative feed timestamp; `time` is deprecated.
 */
export function buildNswFacility(
  entry: NswFacilityListEntry,
  detail?: NswFacilityDetail | null,
): ParkingFacility | null {
  const facilityId = entry.facility_id;
  if (!facilityId) return null;

  const known = KNOWN_FACILITIES[facilityId];

  let lat: number | undefined;
  let lng: number | undefined;
  let capacity: number | undefined;
  let freeSpaces: number | undefined;
  let dataUpdatedAt: string | undefined;
  let hasRealtimeData = false;

  if (known) {
    lat = known.lat;
    lng = known.lng;
    capacity = known.capacity;
  }

  if (detail) {
    const detailLat = Number(detail.location?.latitude);
    const detailLng = Number(detail.location?.longitude);
    if (Number.isFinite(detailLat) && Number.isFinite(detailLng)) {
      lat = detailLat;
      lng = detailLng;
    }
    const detailSpots = parseIntStrict(detail.spots);
    const detailTotal = parseIntStrict(detail.occupancy?.total ?? null);
    if (detailSpots != null && detailSpots > 0) {
      capacity = detailSpots;
    }
    if (detailSpots != null && detailTotal != null) {
      freeSpaces = Math.max(0, detailSpots - detailTotal);
      hasRealtimeData = true;
    }
    if (detail.MessageDate) {
      dataUpdatedAt = detail.MessageDate;
    }
  }

  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const name = entry.facility_name || known?.name || `Car Park ${facilityId}`;
  const address = detail?.location?.address
    ? [detail.location.address, detail.location.suburb].filter(Boolean).join(", ")
    : undefined;

  return {
    id: `nsw:${facilityId}`,
    name,
    coordinates: [lng, lat],
    sources: ["nsw-au"],
    parkingType: "surface" as ParkingType, // Park & Ride lots are typically surface
    capacity: capacity != null && capacity > 0 ? capacity : undefined,
    freeSpaces,
    hasRealtimeData,
    dataUpdatedAt,
    realtimeDataUpdatedAt: hasRealtimeData ? dataUpdatedAt : undefined,
    fee: "free", // Park & Ride is generally free
    parkAndRide: true,
    address,
  };
}

async function fetchFacilityList(apiKey: string): Promise<NswFacilityListEntry[]> {
  if (listCache && Date.now() - listCache.fetchedAt < LIST_CACHE_TTL) {
    return listCache.entries;
  }

  const res = await fetch(`${API_BASE}/carpark`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (listCache) return listCache.entries;
    return [];
  }

  // Per TfNSW Car Park API documentation v2.3 (December 2025): the list
  // endpoint always returns a bare JSON array of { facility_id, facility_name }.
  const data = (await res.json()) as NswFacilityListEntry[];
  const entries = Array.isArray(data)
    ? data.filter((e): e is NswFacilityListEntry => !!e?.facility_id)
    : [];

  listCache = { entries, fetchedAt: Date.now() };
  return entries;
}

async function fetchFacilityDetail(
  apiKey: string,
  facilityId: string,
): Promise<NswFacilityDetail | null> {
  const cached = detailCache.get(facilityId);
  if (cached && Date.now() - cached.fetchedAt < OCCUPANCY_CACHE_TTL) {
    return cached.detail;
  }

  try {
    const res = await fetch(`${API_BASE}/carpark?facility=${encodeURIComponent(facilityId)}`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return cached?.detail ?? null;

    const data = (await res.json()) as NswFacilityDetail;
    if (!data || typeof data !== "object" || !data.facility_id) {
      return cached?.detail ?? null;
    }
    detailCache.set(facilityId, { detail: data, fetchedAt: Date.now() });
    return data;
  } catch {
    return cached?.detail ?? null;
  }
}

async function fetchDetailBatch(apiKey: string, facilityIds: string[]): Promise<void> {
  const BATCH_SIZE = 5;
  for (let i = 0; i < facilityIds.length; i += BATCH_SIZE) {
    const batch = facilityIds.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map((id) => fetchFacilityDetail(apiKey, id)));
  }
}

function buildFromEntriesWithCache(entries: NswFacilityListEntry[]): ParkingFacility[] {
  const facilities: ParkingFacility[] = [];
  for (const entry of entries) {
    const cached = detailCache.get(entry.facility_id);
    const fresh = cached && Date.now() - cached.fetchedAt < OCCUPANCY_CACHE_TTL;
    const facility = buildNswFacility(entry, fresh ? cached.detail : null);
    if (facility) facilities.push(facility);
  }
  return facilities;
}

export async function searchNswAu(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const apiKey = getApiKey();
  if (!apiKey) return [];

  const entries = await fetchFacilityList(apiKey);

  // Build using only static info first so we can bbox-filter cheaply.
  const staticFacilities = buildFromEntriesWithCache(entries);
  const inBbox = staticFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });

  // Fetch live detail for visible facilities.
  const visibleEntries = entries.filter((e) => inBbox.some((f) => f.id === `nsw:${e.facility_id}`));
  await fetchDetailBatch(
    apiKey,
    visibleEntries.map((e) => e.facility_id),
  );

  return visibleEntries
    .map((entry) => {
      const cached = detailCache.get(entry.facility_id);
      return buildNswFacility(entry, cached?.detail ?? null);
    })
    .filter((f): f is ParkingFacility => f != null);
}

export async function fetchNswAuDetail(facilityId: string): Promise<ParkingFacility | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const entries = await fetchFacilityList(apiKey);
  const entry =
    entries.find((e) => e.facility_id === facilityId) ??
    (KNOWN_FACILITIES[facilityId]
      ? { facility_id: facilityId, facility_name: KNOWN_FACILITIES[facilityId].name }
      : null);
  if (!entry) return null;

  const detail = await fetchFacilityDetail(apiKey, facilityId);
  return buildNswFacility(entry, detail);
}
