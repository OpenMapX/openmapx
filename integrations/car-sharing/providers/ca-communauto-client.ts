/**
 * Communauto car-sharing client (Canada).
 *
 * Station-based ("station" / round-trip) car sharing. Communauto exposes its
 * public Reservauto "Front Office" REST API, which the operator's own website
 * and apps consume; it is unauthenticated but bot-filters the default runtime
 * User-Agent, so we send our identifying `USER_AGENT` (verified accepted).
 *
 * Data-use note: there is no published open-data license for this endpoint
 * (see manifest `dataSources` -> `ca-communauto`, commercialUse: "conditional").
 * We restrict to the Canadian cities only and deliberately exclude Communauto's
 * French cities (Paris/Montpellier/etc.), where the EU sui-generis database
 * right makes systematic extraction materially riskier.
 *
 * The `StationAvailability` endpoint reports, per station, whether a vehicle is
 * bookable for the requested time window (via `recommendedVehicleId` /
 * `satisfiesFilters`) rather than a live count, so we surface availability as
 * 1 (a car is bookable now) or 0 (none), and keep every returned station on the
 * map (`isActive: true`).
 */

import { type BoundingBox, bboxContains, fetchJson, type LngLat } from "@openmapx/core";
import { type CacheClient, cacheGet, cacheSet, TTL } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { RegionalCarSharingClient } from "./regional-client-types.js";

const CA_COMMUNAUTO_BASE = "https://restapifrontoffice.reservauto.net/api/v2";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Reservauto `CityId`s covering Canada, with the centroid of their live station
 * set (used only for bbox pre-filtering) and a generous coverage radius. French
 * CityIds are intentionally omitted. Centroids/radii derived from the live feed.
 */
const CA_COMMUNAUTO_CITIES: {
  cityId: number;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}[] = [
  { cityId: 59, name: "Montréal", lat: 45.527, lng: -73.598, radiusKm: 45 },
  { cityId: 88, name: "Montréal (South Shore)", lat: 45.529, lng: -73.613, radiusKm: 30 },
  { cityId: 109, name: "Montréal (extra)", lat: 45.513, lng: -73.644, radiusKm: 30 },
  { cityId: 113, name: "Montérégie", lat: 45.606, lng: -73.975, radiusKm: 80 },
  { cityId: 89, name: "Sherbrooke", lat: 45.395, lng: -71.901, radiusKm: 25 },
  { cityId: 90, name: "Québec City", lat: 46.827, lng: -71.217, radiusKm: 90 },
  { cityId: 108, name: "Québec (extra)", lat: 46.836, lng: -71.293, radiusKm: 25 },
  { cityId: 110, name: "Trois-Rivières", lat: 46.344, lng: -72.55, radiusKm: 25 },
  { cityId: 112, name: "Centre-du-Québec", lat: 46.057, lng: -71.954, radiusKm: 30 },
  { cityId: 92, name: "Halifax", lat: 44.652, lng: -63.593, radiusKm: 25 },
  { cityId: 93, name: "Ottawa", lat: 45.404, lng: -75.706, radiusKm: 30 },
  { cityId: 94, name: "Gatineau", lat: 45.448, lng: -75.766, radiusKm: 30 },
  { cityId: 97, name: "Kingston", lat: 44.24, lng: -76.491, radiusKm: 20 },
  { cityId: 103, name: "Waterloo Region / Hamilton", lat: 43.36, lng: -80.321, radiusKm: 75 },
  { cityId: 105, name: "Toronto", lat: 43.673, lng: -79.402, radiusKm: 40 },
  { cityId: 106, name: "Edmonton", lat: 53.533, lng: -113.498, radiusKm: 25 },
  { cityId: 107, name: "Calgary", lat: 51.047, lng: -114.084, radiusKm: 25 },
  { cityId: 111, name: "Winnipeg", lat: 49.884, lng: -97.149, radiusKm: 30 },
];

/** Wide Canada bbox; results are already scoped by `CityId`, so this only needs to be a superset. */
const CANADA_BBOX = { maxLat: 72, minLat: 41, maxLng: -52, minLng: -142 };

interface CommunautoStationLocation {
  latitude: number;
  longitude: number;
}

interface CommunautoStation {
  stationId: number;
  stationName?: string;
  stationNb?: string;
  stationLocation?: CommunautoStationLocation;
  recommendedVehicleId?: number | null;
  satisfiesFilters?: boolean;
}

interface CommunautoStationAvailabilityResponse {
  stations?: CommunautoStation[];
}

/** A station has a bookable car for the requested window when the API recommends a vehicle. */
function isStationAvailable(s: CommunautoStation): boolean {
  return s.recommendedVehicleId != null || s.satisfiesFilters === true;
}

/** Map a raw Reservauto station to the canonical model. Returns null if it lacks coordinates. */
export function mapCommunautoStation(
  cityId: number,
  s: CommunautoStation,
): SharedMobilityStation | null {
  const loc = s.stationLocation;
  if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;

  const available = isStationAvailable(s);
  return {
    id: `ca-communauto/${cityId}/${s.stationId}`,
    name: s.stationName || `Station ${s.stationNb ?? s.stationId}`,
    coordinates: [loc.longitude, loc.latitude] as LngLat,
    availableVehicles: available ? 1 : 0,
    operator: "Communauto",
    vehicleTypes: ["car"],
    stationType: "fixed",
    isActive: true,
    isRenting: available,
    website: "https://www.communauto.com",
    sources: ["ca-communauto"],
  };
}

/** Parse a StationAvailability response body into canonical stations. */
export function parseCommunautoStations(
  cityId: number,
  body: CommunautoStationAvailabilityResponse,
): SharedMobilityStation[] {
  const out: SharedMobilityStation[] = [];
  for (const s of body.stations ?? []) {
    const mapped = mapCommunautoStation(cityId, s);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Reservauto requires a booking window; a short window starting shortly from now yields live availability. */
function bookingWindow(): { start: string; end: string } {
  const now = Date.now();
  const start = new Date(now + 5 * 60_000);
  const end = new Date(now + 65 * 60_000);
  return { start: start.toISOString().slice(0, 19), end: end.toISOString().slice(0, 19) };
}

/** Fetch (and cache) all stations for one city, then filter to the viewport. */
async function fetchCityStations(
  city: (typeof CA_COMMUNAUTO_CITIES)[number],
  bbox: BoundingBox,
  cache: CacheClient,
): Promise<SharedMobilityStation[]> {
  const cacheKey = `cache:carsharing:ca-communauto:${city.cityId}`;
  let stations = await cacheGet<SharedMobilityStation[]>(cache, cacheKey);

  if (!stations) {
    const { start, end } = bookingWindow();
    const url =
      `${CA_COMMUNAUTO_BASE}/StationAvailability?CityId=${city.cityId}` +
      `&MaxLatitude=${CANADA_BBOX.maxLat}&MinLatitude=${CANADA_BBOX.minLat}` +
      `&MaxLongitude=${CANADA_BBOX.maxLng}&MinLongitude=${CANADA_BBOX.minLng}` +
      `&StartDate=${start}&EndDate=${end}`;
    try {
      const body = await fetchJson<CommunautoStationAvailabilityResponse>(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      stations = parseCommunautoStations(city.cityId, body);
      await cacheSet(cache, cacheKey, stations, TTL.sharedMobility.stations);
    } catch {
      return [];
    }
  }

  return stations.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
}

/** Search Communauto stations within a bounding box across all matching Canadian cities. */
async function searchCaCommunauto(
  bbox: BoundingBox,
  cache: CacheClient,
): Promise<SharedMobilityStation[]> {
  const padding = 1; // ~1° latitude of slack around each city centroid
  const cities = CA_COMMUNAUTO_CITIES.filter((c) => {
    const pad = c.radiusKm / 111 + padding;
    return (
      c.lat >= bbox.south - pad &&
      c.lat <= bbox.north + pad &&
      c.lng >= bbox.west - pad &&
      c.lng <= bbox.east + pad
    );
  });
  if (cities.length === 0) return [];

  const results = await Promise.allSettled(
    cities.map((city) => fetchCityStations(city, bbox, cache)),
  );

  const stations: SharedMobilityStation[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") stations.push(...r.value);
  }
  return stations;
}

export const caCommunautoClient: RegionalCarSharingClient = {
  id: "ca-communauto",
  name: "Communauto",
  regions: CA_COMMUNAUTO_CITIES.map((c) => ({
    center: [c.lng, c.lat] as LngLat,
    radiusKm: c.radiusKm,
  })),
  attribution: {
    label: "Communauto",
    url: "https://www.communauto.com",
    license: "© Communauto (no open-data license)",
    licenseUrl: "https://www.communauto.com/",
  },
  search: searchCaCommunauto,
};
