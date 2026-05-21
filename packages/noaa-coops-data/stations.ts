import type { CacheClient, Logger } from "@openmapx/integration-framework";
import type { NoaaStation, NoaaStationType } from "./types.js";

const MDAPI_BASE = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json";

const STATIONS_CACHE_KEY = "stations:catalog";
const STATIONS_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days
const FETCH_TIMEOUT_MS = 15_000;

/** MDAPI station type filter values supported by NOAA. */
const TYPE_PARAM: Record<NoaaStationType, string> = {
  "tide-predictions": "tidepredictions",
  "water-level": "waterlevels",
  currents: "currents",
  "currents-predictions": "currentpredictions",
};

const DEFAULT_TYPES: NoaaStationType[] = [
  "tide-predictions",
  "water-level",
  "currents-predictions",
];

interface MdapiStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  state?: string;
  timezonecorr?: number;
  tidal?: boolean;
}

interface MdapiResponse {
  count?: number;
  stations: MdapiStation[];
}

/**
 * Fetch one MDAPI station-list response.
 */
async function fetchOneType(type: NoaaStationType, log: Logger): Promise<MdapiStation[]> {
  const url = `${MDAPI_BASE}?type=${TYPE_PARAM[type]}&units=english&application=OpenMapX`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      log.warn(`noaa-coops: MDAPI ${type} returned HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as MdapiResponse;
    return body.stations ?? [];
  } catch (err) {
    log.warn(
      `noaa-coops: MDAPI ${type} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a deduplicated catalog spanning every MDAPI station type that
 * OpenMapX consumes. A single station ID can appear in multiple type
 * collections (e.g. water-level + tide-predictions for the same physical
 * gauge); we union them and record every type the station offers.
 */
export async function loadStations(
  cache: CacheClient,
  log: Logger,
  types: NoaaStationType[] = DEFAULT_TYPES,
): Promise<NoaaStation[]> {
  const cached = await cache.get<NoaaStation[]>(STATIONS_CACHE_KEY);
  if (cached?.length) return cached;

  const responses = await Promise.all(types.map((t) => fetchOneType(t, log)));
  const byId = new Map<string, NoaaStation>();

  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    for (const s of responses[i]) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
      const existing = byId.get(s.id);
      if (existing) {
        if (!existing.types.includes(type)) existing.types.push(type);
        // currents stations don't carry `tidal`; preserve once we've seen it.
        if (existing.tidal === undefined && typeof s.tidal === "boolean") {
          existing.tidal = s.tidal;
        }
      } else {
        byId.set(s.id, {
          id: s.id,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          state: s.state,
          timezoneCorrHours: typeof s.timezonecorr === "number" ? s.timezonecorr : undefined,
          types: [type],
          tidal: typeof s.tidal === "boolean" ? s.tidal : undefined,
        });
      }
    }
  }

  const stations = Array.from(byId.values());
  await cache.set(STATIONS_CACHE_KEY, stations, STATIONS_CACHE_TTL);
  log.info(`noaa-coops: cached ${stations.length} stations across ${types.length} type(s)`);
  return stations;
}

export interface NearestStation {
  station: NoaaStation;
  distanceKm: number;
}

/**
 * Find the closest station to a coordinate within `maxKm`. Optionally filter
 * to stations that publish a specific data type (e.g. `tide-predictions`).
 */
export function findNearestStation(
  stations: NoaaStation[],
  lat: number,
  lng: number,
  maxKm: number,
  requireType?: NoaaStationType,
): NearestStation | null {
  let best: NearestStation | null = null;
  for (const s of stations) {
    if (requireType && !s.types.includes(requireType)) continue;
    const distKm = haversineKm(lat, lng, s.lat, s.lng);
    if (distKm <= maxKm && (best === null || distKm < best.distanceKm)) {
      best = { station: s, distanceKm: distKm };
    }
  }
  return best;
}

/** Find a single station by ID. */
export function findStationById(stations: NoaaStation[], id: string): NoaaStation | null {
  return stations.find((s) => s.id === id) ?? null;
}

export interface BboxQuery {
  west: number;
  south: number;
  east: number;
  north: number;
  types?: NoaaStationType[];
}

/** Stations inside a bbox, optionally filtered by type. */
export function queryStationsInBbox(stations: NoaaStation[], opts: BboxQuery): NoaaStation[] {
  const { west, south, east, north, types } = opts;
  const typeFilter = types && types.length > 0 ? new Set(types) : null;
  const crossesAntimeridian = west > east;

  const out: NoaaStation[] = [];
  for (const s of stations) {
    if (s.lat < south || s.lat > north) continue;
    if (crossesAntimeridian) {
      if (s.lng < west && s.lng > east) continue;
    } else {
      if (s.lng < west || s.lng > east) continue;
    }
    if (typeFilter && !s.types.some((t) => typeFilter.has(t))) continue;
    out.push(s);
  }
  return out;
}

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
