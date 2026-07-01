import { type BoundingBox, USER_AGENT } from "@openmapx/core";
import type {
  EvChargingSource,
  EvChargingStation,
  EvChargingStatus,
} from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxCenter,
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  haversineMeters,
  inferCurrentType,
  isSafeHttpUrl,
  normalizeConnectorType,
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
// US + CA bounding box. Mexico is not meaningfully populated (per dataset review).
const COVERAGE = { south: 18, west: -180, north: 72, east: -62 };
const METERS_PER_MILE = 1609.344;
const MAX_RADIUS_MILES = 500;
const NEAREST_LIMIT = 200;

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

interface LevelAssignment {
  level: "level1" | "level2" | "dc";
  raw: string;
}

interface LevelTotals {
  level1: number;
  level2: number;
  dc: number;
}

function classifyConnector(raw: string, totals: LevelTotals): LevelAssignment {
  const lower = raw.toLowerCase();
  if (lower === "j1772combo" || lower.includes("combo") || lower.includes("ccs")) {
    return { level: "dc", raw };
  }
  if (lower.includes("chademo")) return { level: "dc", raw };
  if (lower === "nema515" || lower === "nema520") return { level: "level1", raw };
  if (lower === "j1772" || lower === "nema1450") return { level: "level2", raw };
  // TESLA / J3271 / NACS are ambiguous — DC at Superchargers, AC at Destination
  // Chargers. Use station-level port counts to decide.
  if (lower === "tesla" || lower === "j3271" || lower === "nacs") {
    if (totals.dc > 0 && totals.level2 === 0) return { level: "dc", raw };
    if (totals.level2 > 0 && totals.dc === 0) return { level: "level2", raw };
    return { level: totals.dc > 0 ? "dc" : "level2", raw };
  }
  // Unknown plug: fall back to `inferCurrentType` heuristics, then default to L2.
  const current = inferCurrentType(normalizeConnectorType(raw) ?? raw);
  return { level: current === "DC" ? "dc" : "level2", raw };
}

function buildConnectors(station: AfdcStation): EvChargingStation["connectors"] {
  const declared = (station.ev_connector_types ?? [])
    .map(cleanString)
    .filter((entry): entry is string => Boolean(entry));

  const totals = {
    level1: parseInteger(station.ev_level1_evse_num) ?? 0,
    level2: parseInteger(station.ev_level2_evse_num) ?? 0,
    dc: parseInteger(station.ev_dc_fast_num) ?? 0,
  };

  // Without declared connector types, emit a synthetic entry per non-zero level so
  // total port counts stay accurate.
  if (declared.length === 0) {
    const synthetic: EvChargingStation["connectors"] = [];
    if (totals.level1)
      synthetic.push(connector({ type: "Level 1", currentType: "AC", quantity: totals.level1 }));
    if (totals.level2)
      synthetic.push(connector({ type: "J1772", currentType: "AC", quantity: totals.level2 }));
    if (totals.dc)
      synthetic.push(connector({ type: "DC Fast", currentType: "DC", quantity: totals.dc }));
    return synthetic;
  }

  const assignments = declared.map((raw) => classifyConnector(raw, totals));
  const countByLevel = {
    level1: assignments.filter((a) => a.level === "level1").length,
    level2: assignments.filter((a) => a.level === "level2").length,
    dc: assignments.filter((a) => a.level === "dc").length,
  };

  // Distribute level totals evenly across declared types in that level — NREL gives
  // aggregate port counts per level, not per connector type, so splitting prevents
  // double-counting during dedup merges.
  return assignments.map((a, idx) => {
    const total = totals[a.level];
    const peers = countByLevel[a.level] || 1;
    const base = Math.floor(total / peers);
    // Spread the remainder across the first few peers so the sum stays exact.
    const remainder = total - base * peers;
    const orderInLevel = assignments
      .slice(0, idx)
      .filter((other) => other.level === a.level).length;
    const quantity = base + (orderInLevel < remainder ? 1 : 0);

    return connector({
      type: a.raw,
      currentType: a.level === "dc" ? "DC" : "AC",
      quantity: quantity > 0 ? quantity : undefined,
    });
  });
}

function stationToCanonical(station: AfdcStation): EvChargingStation | null {
  const id = cleanString(String(station.id ?? ""));
  const lat = typeof station.latitude === "number" ? station.latitude : Number(station.latitude);
  const lng = typeof station.longitude === "number" ? station.longitude : Number(station.longitude);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

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
    connectors: buildConnectors(station),
    updatedAt: cleanString(station.updated_at) ?? cleanString(station.date_last_confirmed),
    sourceUrl: AFDC_STATION_URL,
  };
}

function authHeaders(): Record<string, string> {
  // Pass the key in a header, not a query param, so it never lands in
  // request logs, referers, or browser network panels (per NLR docs).
  return {
    "User-Agent": USER_AGENT,
    "X-Api-Key": afdcApiKey as string,
  };
}

export async function searchAfdcCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!afdcApiKey || !bboxOverlaps(bbox, COVERAGE)) return [];
  const [lng, lat] = bboxCenter(bbox);
  const params = new URLSearchParams({
    fuel_type: "ELEC",
    // `country=all` is required to include Canadian stations; default is US-only.
    country: "all",
    // Default to public, operational stations for consumer map use.
    status: "E",
    access: "public",
    latitude: String(lat),
    longitude: String(lng),
    radius: String(bboxRadiusMiles(bbox)),
    limit: String(NEAREST_LIMIT),
    format: "json",
  });

  const response = await fetch(`${AFDC_NEAREST_URL}?${params.toString()}`, {
    headers: authHeaders(),
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
  const response = await fetch(`${AFDC_DETAIL_BASE}/${encodeURIComponent(id)}.json`, {
    headers: authHeaders(),
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
