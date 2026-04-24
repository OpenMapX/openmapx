/**
 * Deutsche Bahn Shared Mobility GBFS client.
 * Fetches Call-a-Bike / StadtRad / RegioRad stations via DB API Marketplace.
 * Requires DB-Client-ID and DB-Api-Key headers for authentication.
 * https://apis.deutschebahn.com/db-api-marketplace/apis/shared-mobility-gbfs/v2/de
 */

import { type BoundingBox, bboxContains, type LngLat, USER_AGENT } from "@openmapx/core";
import type {
  GbfsV23FreeBikeStatus,
  GbfsV23StationInformation,
  GbfsV23StationStatus,
  GbfsV23SystemInformation,
  GbfsV23VehicleTypes,
} from "@openmapx/mobility-formats";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

const BASE_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/shared-mobility-gbfs/v2/de";
const PROVIDER_IDS = [
  "CallABike",
  "StadtRadHamburg",
  "RegioRadStuttgart",
  "StadtRADLueneburg",
] as const;
const FETCH_TIMEOUT_MS = 10_000;

// In-memory cache — DB systems are regional, TTL matches other shared-mobility clients
interface CachedData {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
  expiresAt: number;
}
const cache = new Map<string, CachedData>();
const CACHE_TTL_MS = 120_000; // 2 min

// Populated by setup(ctx) from the resolved integration config cascade.
let cachedClientId: string | undefined;
let cachedApiKey: string | undefined;

export function setDbBikeCredentials(creds: { clientId?: string; apiKey?: string }): void {
  cachedClientId = creds.clientId && creds.clientId.length > 0 ? creds.clientId : undefined;
  cachedApiKey = creds.apiKey && creds.apiKey.length > 0 ? creds.apiKey : undefined;
}

function getCredentials(): { clientId: string; apiKey: string } | null {
  if (!cachedClientId || !cachedApiKey) return null;
  return { clientId: cachedClientId, apiKey: cachedApiKey };
}

async function fetchJson<T>(
  url: string,
  creds: { clientId: string; apiKey: string },
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "DB-Client-ID": creds.clientId,
        "DB-Api-Key": creds.apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type RawStationStatus = GbfsV23StationStatus["data"]["stations"][number];
type RawVehicleType = GbfsV23VehicleTypes["data"]["vehicle_types"][number];

async function fetchProvider(
  providerId: string,
  bbox: BoundingBox,
  creds: { clientId: string; apiKey: string },
): Promise<{
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
}> {
  // Check cache
  const cached = cache.get(providerId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      stations: cached.stations.filter((s) =>
        bboxContains(bbox, s.coordinates[1], s.coordinates[0]),
      ),
      vehicles: cached.vehicles.filter((v) =>
        bboxContains(bbox, v.coordinates[1], v.coordinates[0]),
      ),
    };
  }

  const base = `${BASE_URL}/${providerId}`;

  // Fetch all feeds in parallel
  const [sysInfoRes, stInfoRes, stStatusRes, freeBikeRes, vTypesRes] = await Promise.all([
    fetchJson<GbfsV23SystemInformation>(`${base}/system_information`, creds),
    fetchJson<GbfsV23StationInformation>(`${base}/station_information`, creds),
    fetchJson<GbfsV23StationStatus>(`${base}/station_status`, creds),
    fetchJson<GbfsV23FreeBikeStatus>(`${base}/free_bike_status`, creds),
    fetchJson<GbfsV23VehicleTypes>(`${base}/vehicle_types`, creds),
  ]);

  const operator = sysInfoRes?.data?.operator ?? sysInfoRes?.data?.name ?? providerId;
  const source = `db-bike/${providerId}`;

  // Build station status lookup
  const statusMap = new Map<string, RawStationStatus>();
  for (const s of stStatusRes?.data?.stations ?? []) {
    statusMap.set(s.station_id, s);
  }

  // Build vehicle type lookup
  const vehicleTypeMap = new Map<string, RawVehicleType>();
  for (const vt of vTypesRes?.data?.vehicle_types ?? []) {
    vehicleTypeMap.set(vt.vehicle_type_id, vt);
  }

  // Map stations
  const stations: SharedMobilityStation[] = [];
  for (const info of stInfoRes?.data?.stations ?? []) {
    const status = statusMap.get(info.station_id);
    if (!status) continue;
    if (!status.is_installed || !status.is_renting) continue;

    stations.push({
      id: `${source}/${info.station_id}`,
      name: info.name,
      coordinates: [info.lon, info.lat] as LngLat,
      availableVehicles: status.num_bikes_available,
      emptySlots: status.num_docks_available,
      capacity: info.capacity,
      operator,
      vehicleTypes: ["bicycle"],
      isActive: true,
      sources: [source],
    });
  }

  // Map free-floating vehicles (skip those docked at stations)
  const vehicles: SharedMobilityVehicle[] = [];
  for (const bike of freeBikeRes?.data?.bikes ?? []) {
    if (bike.is_reserved || bike.is_disabled) continue;
    if (!bike.lat || !bike.lon) continue;
    if (bike.station_id) continue;

    const vt = bike.vehicle_type_id ? vehicleTypeMap.get(bike.vehicle_type_id) : undefined;
    const propulsion = vt?.propulsion_type as SharedMobilityVehicle["propulsion"] | undefined;

    vehicles.push({
      id: `${source}/${bike.bike_id}`,
      coordinates: [bike.lon, bike.lat] as LngLat,
      formFactor: "bicycle",
      propulsion:
        propulsion === "human" || propulsion === "electric_assist" || propulsion === "electric"
          ? propulsion
          : undefined,
      batteryLevel:
        bike.current_fuel_percent != null ? Math.round(bike.current_fuel_percent * 100) : undefined,
      rangeMeters: bike.current_range_meters,
      isReserved: bike.is_reserved,
      isDisabled: bike.is_disabled,
      operator,
      sources: [source],
    });
  }

  // Cache all data (pre-bbox-filter)
  cache.set(providerId, {
    stations,
    vehicles,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  // Filter to bbox
  return {
    stations: stations.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0])),
    vehicles: vehicles.filter((v) => bboxContains(bbox, v.coordinates[1], v.coordinates[0])),
  };
}

/**
 * Search all DB bike-sharing providers and return stations + vehicles in the bbox.
 * Returns empty arrays if DB credentials are not configured.
 */
export async function searchDbBikes(bbox: BoundingBox): Promise<{
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
}> {
  const creds = getCredentials();
  if (!creds) return { stations: [], vehicles: [] };

  const results = await Promise.allSettled(
    PROVIDER_IDS.map((id) => fetchProvider(id, bbox, creds)),
  );

  const stations: SharedMobilityStation[] = [];
  const vehicles: SharedMobilityVehicle[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      stations.push(...r.value.stations);
      vehicles.push(...r.value.vehicles);
    }
  }

  console.log(
    `[db-bike] ${stations.length} stations, ${vehicles.length} free-floating from ${PROVIDER_IDS.length} providers`,
  );

  return { stations, vehicles };
}
