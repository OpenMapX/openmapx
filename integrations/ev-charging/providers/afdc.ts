import { type BoundingBox, USER_AGENT } from "@openmapx/core";
import { getEvChargingSourcePriority } from "./source-priority.js";
import type { EvChargingSource, EvChargingStation, EvChargingStatus } from "./types.js";
import {
  bboxCenter,
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  haversineMeters,
  isSafeHttpUrl,
  parseInteger,
} from "./utils.js";

interface AfdcStation {
  id?: number | string;
  station_name?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  latitude?: number | string;
  longitude?: number | string;
  status_code?: string;
  access_code?: string;
  access_days_time?: string;
  ev_network?: string;
  ev_network_web?: string;
  ev_connector_types?: string[];
  ev_level1_evse_num?: number | string;
  ev_level2_evse_num?: number | string;
  ev_dc_fast_num?: number | string;
  ev_pricing?: string;
  date_last_confirmed?: string;
  updated_at?: string;
}

interface AfdcResponse {
  fuel_stations?: AfdcStation[];
  alt_fuel_station?: AfdcStation;
}

const AFDC_NEAREST_URL = "https://developer.nlr.gov/api/alt-fuel-stations/v1/nearest.json";
const AFDC_DETAIL_BASE = "https://developer.nlr.gov/api/alt-fuel-stations/v1";
const AFDC_STATION_URL = "https://afdc.energy.gov/stations/";
const COVERAGE = { south: 18, west: -180, north: 72, east: -62 };
const METERS_PER_MILE = 1609.344;
const MAX_RADIUS_MILES = 500;

let afdcApiKey: string | undefined;

export function setAfdcApiKey(value: string | undefined): void {
  afdcApiKey = value && value.length > 0 ? value : undefined;
}

function statusFromCode(value: string | undefined): EvChargingStatus {
  if (value === "E") return "operational";
  if (value === "P") return "planned";
  if (value === "T") return "not-operational";
  return "unknown";
}

function bboxRadiusMiles(bbox: BoundingBox): number {
  const center = bboxCenter(bbox);
  const corners: [number, number][] = [
    [bbox.west, bbox.south],
    [bbox.west, bbox.north],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
  ];
  const meters = Math.max(...corners.map((corner) => haversineMeters(center, corner)));
  return Math.min(MAX_RADIUS_MILES, Math.max(1, Math.ceil(meters / METERS_PER_MILE)));
}

function connectorTypes(station: AfdcStation): string[] {
  const explicit = station.ev_connector_types?.map(cleanString).filter(Boolean) as
    | string[]
    | undefined;
  if (explicit?.length) return explicit;
  const inferred: string[] = [];
  if (parseInteger(station.ev_level1_evse_num)) inferred.push("Level 1");
  if (parseInteger(station.ev_level2_evse_num)) inferred.push("J1772");
  if (parseInteger(station.ev_dc_fast_num)) inferred.push("DC Fast");
  return inferred;
}

function stationToCanonical(station: AfdcStation): EvChargingStation | null {
  const id = cleanString(String(station.id ?? ""));
  const lat = typeof station.latitude === "number" ? station.latitude : Number(station.latitude);
  const lng = typeof station.longitude === "number" ? station.longitude : Number(station.longitude);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const dcFast = parseInteger(station.ev_dc_fast_num);
  const level2 = parseInteger(station.ev_level2_evse_num);
  const level1 = parseInteger(station.ev_level1_evse_num);
  const connectors = connectorTypes(station).map((type) =>
    connector({
      type,
      currentType:
        type.toLowerCase().includes("dc") ||
        type.toLowerCase().includes("combo") ||
        type.toLowerCase().includes("chademo")
          ? "DC"
          : "AC",
      quantity:
        type.toLowerCase().includes("dc") ||
        type.toLowerCase().includes("combo") ||
        type.toLowerCase().includes("chademo")
          ? dcFast
          : type.toLowerCase().includes("level 1")
            ? level1
            : level2,
    }),
  );

  return {
    id: `afdc:${id}`,
    sources: ["afdc"],
    sourceItemIds: [`afdc:${id}`],
    name: cleanString(station.station_name) ?? "EV Charging Station",
    coordinates: [lng, lat],
    address: {
      line1: cleanString(station.street_address),
      town: cleanString(station.city),
      state: cleanString(station.state),
      postcode: cleanString(station.zip),
      country: cleanString(station.country),
    },
    operator: station.ev_network
      ? {
          name: station.ev_network,
          url: isSafeHttpUrl(station.ev_network_web) ? station.ev_network_web : undefined,
        }
      : undefined,
    status: statusFromCode(station.status_code),
    usageType: station.access_code === "private" ? "Private" : "Public",
    usageCost: cleanString(station.ev_pricing),
    openingHours: cleanString(station.access_days_time),
    connectors,
    updatedAt: cleanString(station.updated_at) ?? cleanString(station.date_last_confirmed),
    sourceUrl: AFDC_STATION_URL,
  };
}

export async function searchAfdcCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!afdcApiKey || !bboxOverlaps(bbox, COVERAGE)) return [];
  const [lng, lat] = bboxCenter(bbox);
  const params = new URLSearchParams({
    api_key: afdcApiKey,
    fuel_type: "ELEC",
    latitude: String(lat),
    longitude: String(lng),
    radius: String(bboxRadiusMiles(bbox)),
    limit: "all",
    format: "json",
  });

  const response = await fetch(`${AFDC_NEAREST_URL}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`AFDC API error: ${response.status}`);
  const data = (await response.json()) as AfdcResponse;
  return (data.fuel_stations ?? [])
    .map(stationToCanonical)
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchAfdcChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  if (!afdcApiKey) return null;
  const id = itemId.startsWith("afdc:") ? itemId.slice("afdc:".length) : itemId;
  const params = new URLSearchParams({ api_key: afdcApiKey });
  const response = await fetch(`${AFDC_DETAIL_BASE}/${encodeURIComponent(id)}.json?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`AFDC API error: ${response.status}`);
  const data = (await response.json()) as AfdcResponse;
  return data.alt_fuel_station ? stationToCanonical(data.alt_fuel_station) : null;
}

export const afdcSource: EvChargingSource = {
  id: "afdc",
  priority: getEvChargingSourcePriority("afdc"),
  search: searchAfdcCharging,
  canFetchDetail: (itemId) => itemId.startsWith("afdc:"),
  fetchDetail: fetchAfdcChargingDetail,
};
