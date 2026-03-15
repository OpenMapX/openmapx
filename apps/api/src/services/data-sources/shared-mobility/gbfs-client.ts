/**
 * GBFS (General Bikeshare Feed Specification) client.
 * Fetches auto-discovery feed, then individual data feeds.
 */

import type {
  GbfsStationInfo,
  GbfsStationStatus,
  GbfsSystemInfo,
  GbfsVehicleStatus,
  GbfsVehicleType,
} from "./types.js";

const FETCH_TIMEOUT_MS = 8_000;
const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

interface GbfsDiscoveryFeed {
  name: string;
  url: string;
}

interface GbfsDiscoveryResponse {
  data?: {
    // v2 format
    en?: { feeds: GbfsDiscoveryFeed[] };
    // v3 format
    feeds?: GbfsDiscoveryFeed[];
  };
}

interface GbfsFeedResponse<T> {
  data: T;
  last_updated?: number;
  ttl?: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function resolveFeedUrl(discovery: GbfsDiscoveryResponse, feedName: string): string | null {
  // v2: data.en.feeds[] or data.<lang>.feeds[]
  const v2Feeds =
    discovery.data?.en?.feeds ??
    (discovery.data
      ? Object.values(discovery.data).find(
          (v) => typeof v === "object" && v !== null && "feeds" in v,
        )
      : null);
  if (v2Feeds && typeof v2Feeds === "object" && "feeds" in v2Feeds) {
    const feed = (v2Feeds as { feeds: GbfsDiscoveryFeed[] }).feeds.find((f) => f.name === feedName);
    if (feed) return feed.url;
  }
  // v3: data.feeds[]
  const v3Feeds = discovery.data?.feeds;
  if (v3Feeds) {
    const feed = v3Feeds.find((f) => f.name === feedName);
    if (feed) return feed.url;
  }
  return null;
}

export interface GbfsSystemData {
  systemInfo: GbfsSystemInfo | null;
  stations: GbfsStationInfo[];
  stationStatuses: Map<string, GbfsStationStatus>;
  vehicles: GbfsVehicleStatus[];
  vehicleTypes: Map<string, GbfsVehicleType>;
}

/**
 * Fetches all relevant GBFS feeds for a system given its auto-discovery URL.
 */
export async function fetchGbfsSystem(autoDiscoveryUrl: string): Promise<GbfsSystemData | null> {
  const discovery = await fetchJson<GbfsDiscoveryResponse>(autoDiscoveryUrl);
  if (!discovery?.data) return null;

  const systemInfoUrl = resolveFeedUrl(discovery, "system_information");
  const stationInfoUrl = resolveFeedUrl(discovery, "station_information");
  const stationStatusUrl = resolveFeedUrl(discovery, "station_status");
  const vehicleStatusUrl =
    resolveFeedUrl(discovery, "vehicle_status") ?? resolveFeedUrl(discovery, "free_bike_status");
  const vehicleTypesUrl = resolveFeedUrl(discovery, "vehicle_types");

  // Fetch all feeds in parallel
  const [sysInfoRes, stInfoRes, stStatusRes, vStatusRes, vTypesRes] = await Promise.all([
    systemInfoUrl
      ? fetchJson<
          GbfsFeedResponse<{
            system_id: string;
            name: string;
            operator?: string;
            url?: string;
            timezone: string;
            opening_hours?: string;
          }>
        >(systemInfoUrl)
      : null,
    stationInfoUrl
      ? fetchJson<GbfsFeedResponse<{ stations: RawStationInfo[] }>>(stationInfoUrl)
      : null,
    stationStatusUrl
      ? fetchJson<GbfsFeedResponse<{ stations: RawStationStatus[] }>>(stationStatusUrl)
      : null,
    vehicleStatusUrl
      ? fetchJson<GbfsFeedResponse<{ bikes?: RawVehicleStatus[]; vehicles?: RawVehicleStatus[] }>>(
          vehicleStatusUrl,
        )
      : null,
    vehicleTypesUrl
      ? fetchJson<GbfsFeedResponse<{ vehicle_types: RawVehicleType[] }>>(vehicleTypesUrl)
      : null,
  ]);

  const systemInfo: GbfsSystemInfo | null = sysInfoRes?.data
    ? {
        systemId: sysInfoRes.data.system_id,
        name: localizedText(sysInfoRes.data.name),
        operator: sysInfoRes.data.operator ? localizedText(sysInfoRes.data.operator) : undefined,
        url: sysInfoRes.data.url,
        timezone: sysInfoRes.data.timezone,
        openingHours: sysInfoRes.data.opening_hours,
      }
    : null;

  const stations: GbfsStationInfo[] = (stInfoRes?.data?.stations ?? []).map((s) => ({
    stationId: s.station_id,
    name: typeof s.name === "string" ? s.name : localizedText(s.name),
    lat: s.lat,
    lon: s.lon,
    capacity: s.capacity,
    vehicleTypesAvailable: s.vehicle_types_available?.map(
      (v: { vehicle_type_id: string }) => v.vehicle_type_id,
    ),
  }));

  const stationStatuses = new Map<string, GbfsStationStatus>();
  for (const s of stStatusRes?.data?.stations ?? []) {
    stationStatuses.set(s.station_id, {
      stationId: s.station_id,
      numBikesAvailable: s.num_bikes_available ?? s.num_vehicles_available ?? 0,
      numDocksAvailable: s.num_docks_available,
      isInstalled: s.is_installed ?? true,
      isRenting: s.is_renting ?? true,
      isReturning: s.is_returning ?? true,
      vehicleTypesAvailable: s.vehicle_types_available?.map(
        (v: { vehicle_type_id: string; count: number }) => ({
          vehicleTypeId: v.vehicle_type_id,
          count: v.count,
        }),
      ),
    });
  }

  const rawVehicles = vStatusRes?.data?.vehicles ?? vStatusRes?.data?.bikes ?? [];
  const vehicles: GbfsVehicleStatus[] = rawVehicles
    .filter((v) => v.bike_id || v.vehicle_id)
    .map((v) => ({
      bikeId: (v.bike_id ?? v.vehicle_id) as string,
      lat: v.lat,
      lon: v.lon,
      isReserved: v.is_reserved ?? false,
      isDisabled: v.is_disabled ?? false,
      vehicleTypeId: v.vehicle_type_id,
      currentRangeMeters: v.current_range_meters,
      currentFuelPercent: v.current_fuel_percent,
      stationId: v.station_id,
    }));

  const vehicleTypes = new Map<string, GbfsVehicleType>();
  for (const vt of vTypesRes?.data?.vehicle_types ?? []) {
    vehicleTypes.set(vt.vehicle_type_id, {
      vehicleTypeId: vt.vehicle_type_id,
      formFactor: vt.form_factor ?? "bicycle",
      propulsionType: vt.propulsion_type ?? "human",
      name: typeof vt.name === "string" ? vt.name : localizedText(vt.name),
      maxRangeMeters: vt.max_range_meters,
    });
  }

  return { systemInfo, stations, stationStatuses, vehicles, vehicleTypes };
}

function localizedText(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return val[0].text ?? "";
  if (typeof val === "object" && val !== null && "text" in val)
    return (val as { text: string }).text;
  return "";
}

// Raw API response types (snake_case from GBFS)
interface RawStationInfo {
  station_id: string;
  name: string | { text: string }[];
  lat: number;
  lon: number;
  capacity?: number;
  vehicle_types_available?: { vehicle_type_id: string }[];
}

interface RawStationStatus {
  station_id: string;
  num_bikes_available?: number;
  num_vehicles_available?: number;
  num_docks_available?: number;
  is_installed?: boolean;
  is_renting?: boolean;
  is_returning?: boolean;
  vehicle_types_available?: { vehicle_type_id: string; count: number }[];
}

interface RawVehicleStatus {
  bike_id?: string;
  vehicle_id?: string;
  lat?: number;
  lon?: number;
  is_reserved?: boolean;
  is_disabled?: boolean;
  vehicle_type_id?: string;
  current_range_meters?: number;
  current_fuel_percent?: number;
  station_id?: string;
}

interface RawVehicleType {
  vehicle_type_id: string;
  form_factor?: string;
  propulsion_type?: string;
  name?: string | { text: string }[];
  max_range_meters?: number;
}
