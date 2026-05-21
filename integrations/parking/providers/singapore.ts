import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Singapore HDB carpark availability client.
 *
 * Joins two data.gov.sg datasets:
 *   - Real-time availability: /v1/transport/carpark-availability (~1,994 car parks, updated every minute)
 *   - Static HDB carpark info: datastore d_23f946fa557947f93a8043bbef41dd09 (~2,300 records)
 *
 * The static dataset uses SVY21 coordinates (Singapore Transverse Mercator projection)
 * which are converted inline to WGS84 lat/lng.
 *
 * License: Singapore Open Data Licence. No authentication required (60 req/min).
 */

const AVAILABILITY_URL = "https://api.data.gov.sg/v1/transport/carpark-availability";
const STATIC_URL = "https://data.gov.sg/api/action/datastore_search";
const STATIC_RESOURCE_ID = "d_23f946fa557947f93a8043bbef41dd09";

const COVERAGE_BBOX = { south: 1.2, west: 103.6, north: 1.48, east: 104.05 };

const STATIC_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const AVAILABILITY_CACHE_TTL = 2 * 60 * 1000; // 2 min

interface StaticCarparkRecord {
  car_park_no: string;
  address: string;
  x_coord: string;
  y_coord: string;
  car_park_type: string;
  type_of_parking_system: string;
  short_term_parking: string;
  free_parking: string;
  night_parking: string;
  car_park_decks: number;
  gantry_height: number;
  car_park_basement: string;
}

interface StaticDatastoreResponse {
  result: {
    records: StaticCarparkRecord[];
    total: number;
    _links?: { next?: string };
  };
}

interface AvailabilityCarparkInfo {
  total_lots: string;
  lot_type: string; // C = car, Y = motorcycle, H = heavy vehicle
  lots_available: string;
}

interface AvailabilityCarparkData {
  carpark_number: string;
  update_datetime: string;
  carpark_info: AvailabilityCarparkInfo[];
}

interface AvailabilityResponse {
  items: Array<{
    timestamp: string;
    carpark_data: AvailabilityCarparkData[];
  }>;
}

interface StaticCarpark {
  carparkNo: string;
  address: string;
  coordinates: [number, number]; // [lng, lat] WGS84
  parkingType: ParkingType;
  freeParking: boolean;
  nightParking: boolean;
  maxHeight: number | undefined; // cm
  shortTermParking: string;
}

// SVY21 to WGS84 conversion (Transverse Mercator inverse projection)
// Based on https://github.com/cgcai/SVY21 (MIT-compatible, open source)

const SVY21_A = 6378137; // WGS84 semi-major axis
const SVY21_F = 1 / 298.257223563; // WGS84 flattening
const SVY21_OLAT = 1.366666; // Origin latitude (degrees)
const SVY21_OLON = 103.833333; // Origin longitude (degrees)
const SVY21_ON = 38744.572; // False northing
const SVY21_OE = 28001.642; // False easting
const SVY21_K = 1; // Scale factor

const SVY21_B = SVY21_A * (1 - SVY21_F);
const SVY21_E2 = 2 * SVY21_F - SVY21_F * SVY21_F;
const SVY21_E4 = SVY21_E2 * SVY21_E2;
const SVY21_E6 = SVY21_E4 * SVY21_E2;
const SVY21_A0 = 1 - SVY21_E2 / 4 - (3 * SVY21_E4) / 64 - (5 * SVY21_E6) / 256;
const SVY21_A2 = (3 / 8) * (SVY21_E2 + SVY21_E4 / 4 + (15 * SVY21_E6) / 128);
const SVY21_A4 = (15 / 256) * (SVY21_E4 + (3 * SVY21_E6) / 4);
const SVY21_A6 = (35 * SVY21_E6) / 3072;
const SVY21_N = (SVY21_A - SVY21_B) / (SVY21_A + SVY21_B);
const SVY21_N2 = SVY21_N * SVY21_N;
const SVY21_N3 = SVY21_N2 * SVY21_N;
const SVY21_N4 = SVY21_N2 * SVY21_N2;
const SVY21_G =
  SVY21_A *
  (1 - SVY21_N) *
  (1 - SVY21_N2) *
  (1 + (9 * SVY21_N2) / 4 + (225 * SVY21_N4) / 64) *
  (Math.PI / 180);

function calcM(latDeg: number): number {
  const latR = (latDeg * Math.PI) / 180;
  return (
    SVY21_A *
    (SVY21_A0 * latR -
      SVY21_A2 * Math.sin(2 * latR) +
      SVY21_A4 * Math.sin(4 * latR) -
      SVY21_A6 * Math.sin(6 * latR))
  );
}

function calcRho(sin2Lat: number): number {
  return (SVY21_A * (1 - SVY21_E2)) / (1 - SVY21_E2 * sin2Lat) ** 1.5;
}

function calcV(sin2Lat: number): number {
  return SVY21_A / Math.sqrt(1 - SVY21_E2 * sin2Lat);
}

/**
 * Convert SVY21 (Northing, Easting) to WGS84 (latitude, longitude).
 */
function svy21ToWgs84(northing: number, easting: number): { lat: number; lng: number } {
  const Nprime = northing - SVY21_ON;
  const Mo = calcM(SVY21_OLAT);
  const Mprime = Mo + Nprime / SVY21_K;
  const sigma = (Mprime * Math.PI) / (180 * SVY21_G);

  const latPrime =
    sigma +
    ((3 * SVY21_N) / 2 - (27 * SVY21_N3) / 32) * Math.sin(2 * sigma) +
    ((21 * SVY21_N2) / 16 - (55 * SVY21_N4) / 32) * Math.sin(4 * sigma) +
    ((151 * SVY21_N3) / 96) * Math.sin(6 * sigma) +
    ((1097 * SVY21_N4) / 512) * Math.sin(8 * sigma);

  const sinLatPrime = Math.sin(latPrime);
  const sin2LatPrime = sinLatPrime * sinLatPrime;

  const rhoPrime = calcRho(sin2LatPrime);
  const vPrime = calcV(sin2LatPrime);
  const psiPrime = vPrime / rhoPrime;
  const psiPrime2 = psiPrime * psiPrime;
  const psiPrime3 = psiPrime2 * psiPrime;
  const psiPrime4 = psiPrime3 * psiPrime;
  const tPrime = Math.tan(latPrime);
  const tPrime2 = tPrime * tPrime;
  const tPrime4 = tPrime2 * tPrime2;
  const tPrime6 = tPrime4 * tPrime2;
  const Eprime = easting - SVY21_OE;
  const x = Eprime / (SVY21_K * vPrime);
  const x2 = x * x;
  const x3 = x2 * x;
  const x5 = x3 * x2;
  const x7 = x5 * x2;

  const latFactor = tPrime / (SVY21_K * rhoPrime);
  const latTerm1 = latFactor * ((Eprime * x) / 2);
  const latTerm2 =
    latFactor *
    ((Eprime * x3) / 24) *
    (-4 * psiPrime2 + 9 * psiPrime * (1 - tPrime2) + 12 * tPrime2);
  const latTerm3 =
    latFactor *
    ((Eprime * x5) / 720) *
    (8 * psiPrime4 * (11 - 24 * tPrime2) -
      12 * psiPrime3 * (21 - 71 * tPrime2) +
      15 * psiPrime2 * (15 - 98 * tPrime2 + 15 * tPrime4) +
      180 * psiPrime * (5 * tPrime2 - 3 * tPrime4) +
      360 * tPrime4);
  const latTerm4 =
    latFactor * ((Eprime * x7) / 40320) * (1385 - 3633 * tPrime2 + 4095 * tPrime4 + 1575 * tPrime6);

  const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;

  const secLatPrime = 1 / Math.cos(lat);
  const lonTerm1 = x * secLatPrime;
  const lonTerm2 = ((x3 * secLatPrime) / 6) * (psiPrime + 2 * tPrime2);
  const lonTerm3 =
    ((x5 * secLatPrime) / 120) *
    (-4 * psiPrime3 * (1 - 6 * tPrime2) +
      psiPrime2 * (9 - 68 * tPrime2) +
      72 * psiPrime * tPrime2 +
      24 * tPrime4);
  const lonTerm4 =
    ((x7 * secLatPrime) / 5040) * (61 + 662 * tPrime2 + 1320 * tPrime4 + 720 * tPrime6);
  const lon = (SVY21_OLON * Math.PI) / 180 + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

  return { lat: lat / (Math.PI / 180), lng: lon / (Math.PI / 180) };
}

const TYPE_MAP: Record<string, ParkingType> = {
  "MULTI-STOREY CAR PARK": "garage",
  "BASEMENT CAR PARK": "underground",
  "SURFACE CAR PARK": "surface",
  "COVERED CAR PARK": "garage",
  "MECHANISED CAR PARK": "garage",
};

let staticCache: {
  carparks: Map<string, StaticCarpark>;
  fetchedAt: number;
} | null = null;

let availabilityCache: {
  data: Map<string, AvailabilityCarparkData>;
  fetchedAt: number;
} | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

async function fetchStaticData(): Promise<Map<string, StaticCarpark>> {
  if (staticCache && Date.now() - staticCache.fetchedAt < STATIC_CACHE_TTL) {
    return staticCache.carparks;
  }

  const carparks = new Map<string, StaticCarpark>();
  let offset = 0;
  const limit = 500;
  let hasMore = true;

  while (hasMore) {
    const url = `${STATIC_URL}?resource_id=${STATIC_RESOURCE_ID}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      if (staticCache) return staticCache.carparks;
      if (carparks.size > 0) break;
      throw new Error(`HDB carpark info failed: ${res.status}`);
    }

    const body = (await res.json()) as StaticDatastoreResponse;
    const records = body.result.records;

    for (const record of records) {
      const x = Number.parseFloat(record.x_coord);
      const y = Number.parseFloat(record.y_coord);
      if (Number.isNaN(x) || Number.isNaN(y) || x === 0 || y === 0) continue;

      const { lat, lng } = svy21ToWgs84(y, x);
      if (lat < 1.1 || lat > 1.5 || lng < 103.5 || lng > 104.1) continue;

      const gantryHeightM = record.gantry_height;
      const maxHeight =
        gantryHeightM != null && gantryHeightM > 0 ? Math.round(gantryHeightM * 100) : undefined;

      carparks.set(record.car_park_no, {
        carparkNo: record.car_park_no,
        address: record.address,
        coordinates: [lng, lat],
        parkingType: TYPE_MAP[record.car_park_type] ?? "unknown",
        freeParking: record.free_parking !== "NO",
        nightParking: record.night_parking === "YES",
        maxHeight,
        shortTermParking: record.short_term_parking,
      });
    }

    if (records.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }

  staticCache = { carparks, fetchedAt: Date.now() };
  return carparks;
}

async function fetchAvailability(): Promise<Map<string, AvailabilityCarparkData>> {
  if (availabilityCache && Date.now() - availabilityCache.fetchedAt < AVAILABILITY_CACHE_TTL) {
    return availabilityCache.data;
  }

  const res = await fetch(AVAILABILITY_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    if (availabilityCache) return availabilityCache.data;
    throw new Error(`Carpark availability failed: ${res.status}`);
  }

  const body = (await res.json()) as AvailabilityResponse;
  const map = new Map<string, AvailabilityCarparkData>();

  const items = body.items;
  if (items.length > 0) {
    for (const cp of items[0].carpark_data) {
      map.set(cp.carpark_number, cp);
    }
  }

  availabilityCache = { data: map, fetchedAt: Date.now() };
  return map;
}

function buildFacility(
  info: StaticCarpark,
  availability: AvailabilityCarparkData | undefined,
): ParkingFacility {
  let capacity: number | undefined;
  let freeSpaces: number | undefined;

  if (availability) {
    // Sum only car lots (lot_type "C"); skip motorcycle (Y) and heavy vehicle (H)
    let totalCar = 0;
    let freeCar = 0;
    for (const lot of availability.carpark_info) {
      if (lot.lot_type === "C") {
        totalCar += Number.parseInt(lot.total_lots, 10) || 0;
        freeCar += Number.parseInt(lot.lots_available, 10) || 0;
      }
    }
    if (totalCar > 0) {
      capacity = totalCar;
      freeSpaces = freeCar;
    }
  }

  return {
    id: `sg:${info.carparkNo}`,
    name: formatAddress(info.address),
    coordinates: info.coordinates,
    sources: ["singapore"],
    parkingType: info.parkingType,
    capacity,
    freeSpaces,
    hasRealtimeData: availability !== undefined,
    fee: info.freeParking ? "free" : "paid",
    address: info.address,
    maxHeight: info.maxHeight,
  };
}

function formatAddress(raw: string): string {
  // Static data has addresses in all-caps like "BLK 123 ANG MO KIO AVE 6"
  // Title-case them for nicer display
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBlk\b/g, "Blk")
    .replace(/\bHdb\b/g, "HDB")
    .replace(/\bMrt\b/g, "MRT")
    .replace(/\bAve\b/g, "Ave")
    .replace(/\bSt\b/g, "St")
    .replace(/\bDr\b/g, "Dr")
    .replace(/\bRd\b/g, "Rd")
    .replace(/\bCres\b/g, "Cres")
    .replace(/\bCl\b/g, "Cl");
}

export async function searchSingapore(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const [staticResult, availResult] = await Promise.allSettled([
    fetchStaticData(),
    fetchAvailability(),
  ]);

  const statics =
    staticResult.status === "fulfilled" ? staticResult.value : new Map<string, StaticCarpark>();
  const avails =
    availResult.status === "fulfilled"
      ? availResult.value
      : new Map<string, AvailabilityCarparkData>();

  if (statics.size === 0) return [];

  const facilities: ParkingFacility[] = [];
  for (const [carparkNo, info] of statics) {
    const [lng, lat] = info.coordinates;
    if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) continue;

    const availability = avails.get(carparkNo);
    facilities.push(buildFacility(info, availability));
  }

  return facilities;
}

export async function fetchSingaporeDetail(id: string): Promise<ParkingFacility | null> {
  const carparkNo = id.startsWith("sg:") ? id.slice(3) : id;

  const [staticResult, availResult] = await Promise.allSettled([
    fetchStaticData(),
    fetchAvailability(),
  ]);

  const statics =
    staticResult.status === "fulfilled" ? staticResult.value : new Map<string, StaticCarpark>();
  const avails =
    availResult.status === "fulfilled"
      ? availResult.value
      : new Map<string, AvailabilityCarparkData>();

  const info = statics.get(carparkNo);
  if (!info) return null;

  const availability = avails.get(carparkNo);
  return buildFacility(info, availability);
}
