import type { AirportInfo, AirportType, LngLat } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import { type DataStore, getStore } from "./loader.js";
import type { AirportRecord } from "./types.js";

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function stripInternalFields(rec: AirportRecord): AirportInfo {
  const {
    lat: _lat,
    lng: _lng,
    name: _name,
    continent: _continent,
    keywords: _keywords,
    ...info
  } = rec;
  return info;
}

/**
 * Find the nearest aerodrome/heliport to `coords` within `maxKm` great-circle
 * distance. Used by `knowledge-ourairports` as a fallback for airport
 * infrastructure features (terminals, runways, taxiways, etc.) that don't
 * carry IATA/ICAO tags on their own OSM objects but spatially sit inside an
 * airport's footprint.
 */
export async function lookupNearestAerodrome(
  log: Logger,
  coords: LngLat,
  maxKm: number,
): Promise<AirportInfo | null> {
  const data = await getStore(log);
  if (!data) return null;
  return findNearestInStore(data, coords, maxKm);
}

function findNearestInStore(data: DataStore, coords: LngLat, maxKm: number): AirportInfo | null {
  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const baseLat = Math.floor(lat);
  const baseLng = Math.floor(lng);
  let best: AirportRecord | null = null;
  let bestDistKm = Number.POSITIVE_INFINITY;

  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const bucket = data.spatialBuckets.get(`${baseLat + dLat},${baseLng + dLng}`);
      if (!bucket) continue;
      for (const rec of bucket) {
        const distKm = haversineKm(lat, lng, rec.lat, rec.lng);
        if (distKm < bestDistKm && distKm <= maxKm) {
          bestDistKm = distKm;
          best = rec;
        }
      }
    }
  }

  return best ? stripInternalFields(best) : null;
}

/**
 * Code-based lookup. Returns the airport for the first matching key in
 * `keys`, normalising codes to uppercase before lookup.
 */
export async function lookupAirport(
  log: Logger,
  keys: { iata?: string; icao?: string; ident?: string; gpsCode?: string; localCode?: string },
): Promise<AirportInfo | null> {
  const rec = await lookupAirportRecord(log, keys);
  return rec ? stripInternalFields(rec) : null;
}

/**
 * Same as `lookupAirport` but returns the full in-memory `AirportRecord`
 * including `lat`, `lng`, `name`, and `keywords`. Used by callers that need
 * the geo / display fields beyond the public `AirportInfo` subset (e.g.
 * the `oa:` place-resolver in `knowledge-ourairports`).
 */
export async function lookupAirportRecord(
  log: Logger,
  keys: { iata?: string; icao?: string; ident?: string; gpsCode?: string; localCode?: string },
): Promise<AirportRecord | null> {
  const data = await getStore(log);
  if (!data) return null;

  const iata = normalizeCode(keys.iata);
  if (iata) {
    const hit = data.byIata.get(iata);
    if (hit) return hit;
  }
  const icao = normalizeCode(keys.icao);
  if (icao) {
    const hit = data.byIcao.get(icao);
    if (hit) return hit;
    const identHit = data.byIdent.get(icao);
    if (identHit) return identHit;
  }
  const ident = normalizeCode(keys.ident);
  if (ident) {
    const hit = data.byIdent.get(ident);
    if (hit) return hit;
  }
  const gps = normalizeCode(keys.gpsCode);
  if (gps) {
    const hit = data.byGpsCode.get(gps);
    if (hit) return hit;
  }
  const local = normalizeCode(keys.localCode);
  if (local) {
    const hit = data.byLocalCode.get(local);
    if (hit) return hit;
  }
  return null;
}

function normalizeCode(code: string | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export interface BboxQueryOptions {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Airport types to include. Empty means all. */
  types?: AirportType[];
  /** Cap on the number of returned records, ordered by importance (large → small). */
  limit?: number;
  /** When set, exclude airports with `scheduledService=false`. */
  scheduledOnly?: boolean;
}

const QUERY_TYPE_RANK: Record<AirportType, number> = {
  large_airport: 0,
  medium_airport: 1,
  small_airport: 2,
  seaplane_base: 3,
  heliport: 4,
  balloonport: 5,
  closed_airport: 6,
};

/**
 * Return airport records in the given bbox. Ordered by importance (large
 * first) and capped at `limit` so high-zoom queries don't ship megabytes of
 * tiny-airstrip points to the client.
 */
export async function queryAirportsInBbox(
  log: Logger,
  opts: BboxQueryOptions,
): Promise<AirportRecord[]> {
  const data = await getStore(log);
  if (!data) return [];

  const { west, south, east, north, types, limit = 2000, scheduledOnly = false } = opts;
  const typeFilter = types && types.length > 0 ? new Set(types) : null;
  const crossesAntimeridian = west > east;

  const results: AirportRecord[] = [];
  for (const r of data.all) {
    if (r.lat < south || r.lat > north) continue;
    if (crossesAntimeridian) {
      if (r.lng < west && r.lng > east) continue;
    } else {
      if (r.lng < west || r.lng > east) continue;
    }
    if (typeFilter && !typeFilter.has(r.type)) continue;
    if (scheduledOnly && !r.scheduledService) continue;
    results.push(r);
  }

  results.sort((a, b) => {
    const ar = QUERY_TYPE_RANK[a.type] ?? 99;
    const br = QUERY_TYPE_RANK[b.type] ?? 99;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, limit);
}

/**
 * Search the catalog by free-text query. Wraps the in-memory search index.
 */
export async function searchAirports(log: Logger, q: string, limit = 10): Promise<AirportRecord[]> {
  const data = await getStore(log);
  if (!data) return [];
  return data.search.query(q, limit);
}
