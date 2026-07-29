/**
 * TDX (Taiwan Transport Data eXchange, 運輸資料流通服務平台— motc.gov.tw) EV
 * charging APIs: "Basic Information of Charging Stations"
 * (data.gov.tw/dataset/170220) + "Real-Time Status of Charging Guns"
 * (data.gov.tw/dataset/170224). Both are served by the same "綠色運輸-充電樁"
 * OpenAPI 3.0 service, split per jurisdiction:
 *   GET /v1/EV/Station/City/{City}             — station + connector counts
 *   GET /v1/EV/ConnectorLiveStatus/City/{City}  — per-gun live status
 * Base URL + schemas verified against the platform's own OAS document
 * (https://tdx.transportdata.tw/webapi/File/Swagger/V3/b378d320-04a9-4fba-80b8-0df1b96dd5e8).
 *
 * Auth: OIDC client-credentials. TDX members create a Client Id/Secret in
 * the member center, then exchange them for a bearer token at
 * `${TOKEN_URL}` (`grant_type=client_credentials`, form-encoded body).
 * Tokens are typically valid 86400s; cached here with a safety margin and
 * de-duplicated across concurrent callers.
 *
 * License: 政府資料開放授權條款-第1版 (Government Open Data License v1) — free
 * commercial and non-commercial reuse with attribution.
 *
 * Station.ChargingRate/ParkingRate are free-text summary strings in this
 * dataset (no numeric price field), so pricing maps to `usageCost`/`notes`
 * rather than a structured `EvChargingTariff`. TDX does expose a separate,
 * structured `/v1/EV/ChargingRate/City/{City}` rate-detail endpoint (numeric
 * `RatePrice` per `RateType`), but joining it per station/connector is out of
 * scope for this source and left for a future enhancement.
 */
import { type BoundingBox, fetchJson } from "@openmapx/core";
import type {
  EvChargingSource,
  EvChargingStation,
  EvseAvailability,
} from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePriority } from "./source-priority.js";
import { bboxContainsCoordinates, bboxOverlaps, cleanString, connector } from "./utils.js";

interface TdxEvName {
  Zh_tw?: string;
  En?: string;
}

interface TdxAddress {
  City?: string;
  Town?: string;
  Road?: string;
  Lane?: string;
  Alley?: string;
  No?: string;
}

interface TdxLocation {
  Address?: TdxAddress;
}

interface TdxStationConnector {
  /** 充電槍規格: 1 CCS1, 2 CCS2 ("CCCS2" in the source schema), 3 CHAdeMO, 4 Tesla, 5 Type 1 (J1772), 6 Type 2 (Mennekes), 254 Other, 255 Unknown. */
  Type?: number;
  /** 充電電力輸出方式: 1 AC, 2 DC. */
  Power?: number;
  Quantity?: number;
}

interface TdxStation {
  StationID?: string;
  StationName?: TdxEvName;
  OperationType?: number;
  PositionLat?: number | string;
  PositionLon?: number | string;
  Connectors?: TdxStationConnector[];
  ServiceTime?: string;
  /** 充電車位停車費率 — free-text parking-rate description. */
  ParkingRate?: string;
  /** 充電費率 — free-text charging-rate description (not a numeric price). */
  ChargingRate?: string;
  UsageRestriction?: string;
  Location?: TdxLocation;
}

interface TdxStationListResponse {
  Stations?: TdxStation[];
}

interface TdxLiveStatus {
  StationID?: string;
  ChargingPointID?: string;
  ConnectorID?: string;
  /** 充電槍狀態: 1 可使用_閒置 (available/idle), 2 不可使用_佔用或充電中 (occupied/charging), 3 不可使用_異常故障 (fault). */
  ConnectorStatus?: number;
  LastUpdateTime?: string;
}

interface TdxLiveStatusListResponse {
  LiveStatuses?: TdxLiveStatus[];
}

interface TdxTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic";
const TDX_DATASET_URL =
  "https://tdx.transportdata.tw/api-service/swagger/basic/b378d320-04a9-4fba-80b8-0df1b96dd5e8";

const SOURCE_ID = "tw-tdx";
const STATION_PREFIX = "tw-tdx:";
const STATION_PAGE_LIMIT = 200;
const LIVE_STATUS_PAGE_LIMIT = 2000;
const MAX_CITIES_PER_SEARCH = 6;
// 60s safety margin so a token doesn't expire mid-request.
const TOKEN_SAFETY_MARGIN_MS = 60_000;

// Taiwan main island + Penghu. Kinmen/Lienchiang (Matsu) sit west of this box
// (near mainland China) and are intentionally excluded from coverage.
const COVERAGE: BoundingBox = { south: 21.9, west: 119.3, north: 25.4, east: 122.1 };

/**
 * Approximate per-city/county bounding boxes for the jurisdictions the TDX
 * `/City/{City}` EV endpoints cover. These are NOT sourced from TDX — this
 * dataset has no bbox/spatial query parameter, only a `City` path segment —
 * so they're rough, hand-derived boxes used only to decide which `City`
 * values to query for a given map viewport.
 */
const CITY_BBOXES: Record<string, BoundingBox> = {
  Taipei: { west: 121.45, south: 24.96, east: 121.66, north: 25.21 },
  NewTaipei: { west: 121.28, south: 24.6, east: 122.03, north: 25.3 },
  Taoyuan: { west: 121.0, south: 24.75, east: 121.37, north: 25.05 },
  Taichung: { west: 120.48, south: 23.95, east: 121.35, north: 24.35 },
  Tainan: { west: 120.03, south: 22.87, east: 120.75, north: 23.4 },
  Kaohsiung: { west: 120.2, south: 22.45, east: 120.98, north: 23.35 },
  Keelung: { west: 121.7, south: 25.08, east: 121.8, north: 25.2 },
  Hsinchu: { west: 120.94, south: 24.75, east: 121.02, north: 24.83 },
  HsinchuCounty: { west: 120.83, south: 24.45, east: 121.45, north: 24.85 },
  MiaoliCounty: { west: 120.68, south: 24.25, east: 121.25, north: 24.75 },
  ChanghuaCounty: { west: 120.3, south: 23.75, east: 120.65, north: 24.15 },
  NantouCounty: { west: 120.65, south: 23.45, east: 121.3, north: 24.15 },
  YunlinCounty: { west: 120.1, south: 23.55, east: 120.75, north: 23.85 },
  ChiayiCounty: { west: 120.1, south: 23.2, east: 120.8, north: 23.65 },
  Chiayi: { west: 120.42, south: 23.44, east: 120.48, north: 23.5 },
  PingtungCounty: { west: 120.35, south: 21.9, east: 120.95, north: 22.85 },
  YilanCounty: { west: 121.45, south: 24.35, east: 121.98, north: 24.9 },
  HualienCounty: { west: 121.1, south: 22.95, east: 121.7, north: 24.35 },
  TaitungCounty: { west: 120.8, south: 21.9, east: 121.6, north: 23.4 },
  PenghuCounty: { west: 119.3, south: 23.15, east: 119.75, north: 23.8 },
};

const CONNECTOR_TYPE_LABELS: Record<number, string> = {
  1: "CCS1",
  2: "CCS2",
  3: "CHAdeMO",
  4: "Tesla",
  5: "Type 1",
  6: "Type 2",
  254: "Other",
  255: "Unknown",
};

const CURRENT_TYPE_LABELS: Record<number, string> = { 1: "AC", 2: "DC" };

let twTdxClientId: string | undefined;
let twTdxClientSecret: string | undefined;

export function setTwTdxCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
): void {
  const nextId = clientId && clientId.length > 0 ? clientId : undefined;
  const nextSecret = clientSecret && clientSecret.length > 0 ? clientSecret : undefined;
  if (nextId !== twTdxClientId || nextSecret !== twTdxClientSecret) {
    // Credentials changed — drop any cached token from the old pair.
    tokenCache = null;
  }
  twTdxClientId = nextId;
  twTdxClientSecret = nextSecret;
}

function hasCredentials(): boolean {
  return Boolean(twTdxClientId && twTdxClientSecret);
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let inflightToken: Promise<string | null> | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!twTdxClientId || !twTdxClientSecret) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;
  if (inflightToken) return inflightToken;

  inflightToken = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: twTdxClientId as string,
      client_secret: twTdxClientSecret as string,
    });
    const data = await fetchJson<TdxTokenResponse>(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      init: { method: "POST", body: body.toString() },
      nullOnError: true,
    });
    if (!data?.access_token) return null;
    const ttlSeconds = data.expires_in ?? 3600;
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(ttlSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS, 30_000),
    };
    return data.access_token;
  })().finally(() => {
    inflightToken = null;
  });
  return inflightToken;
}

function overlappingCities(bbox: BoundingBox): string[] {
  return Object.entries(CITY_BBOXES)
    .filter(([, box]) => bboxOverlaps(bbox, box))
    .map(([city]) => city)
    .slice(0, MAX_CITIES_PER_SEARCH);
}

function positionFilter(bbox: BoundingBox): string {
  return `PositionLon ge ${bbox.west} and PositionLon le ${bbox.east} and PositionLat ge ${bbox.south} and PositionLat le ${bbox.north}`;
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

async function fetchStations(city: string, filter: string, token: string): Promise<TdxStation[]> {
  const params = new URLSearchParams({
    $filter: filter,
    $top: String(STATION_PAGE_LIMIT),
    $format: "JSON",
  });
  const url = `${API_BASE}/v1/EV/Station/City/${encodeURIComponent(city)}?${params.toString()}`;
  const data = await fetchJson<TdxStationListResponse>(url, {
    headers: { Authorization: `Bearer ${token}` },
    errorMessage: ({ status }) => `TDX Station API error (${city}): ${status}`,
    nullOnError: true,
  });
  return data?.Stations ?? [];
}

async function fetchLiveStatusByStation(
  city: string,
  token: string,
): Promise<Map<string, EvseAvailability>> {
  const params = new URLSearchParams({ $top: String(LIVE_STATUS_PAGE_LIMIT), $format: "JSON" });
  const url = `${API_BASE}/v1/EV/ConnectorLiveStatus/City/${encodeURIComponent(city)}?${params.toString()}`;
  const data = await fetchJson<TdxLiveStatusListResponse>(url, {
    headers: { Authorization: `Bearer ${token}` },
    errorMessage: ({ status }) => `TDX ConnectorLiveStatus API error (${city}): ${status}`,
    nullOnError: true,
  });

  const byStation = new Map<string, EvseAvailability>();
  for (const status of data?.LiveStatuses ?? []) {
    const stationId = cleanString(status.StationID);
    if (!stationId) continue;
    const existing = byStation.get(stationId) ?? {
      available: 0,
      total: 0,
      updatedAt: status.LastUpdateTime ?? new Date().toISOString(),
    };
    existing.total += 1;
    if (status.ConnectorStatus === 1) existing.available += 1;
    if (status.LastUpdateTime && status.LastUpdateTime > existing.updatedAt) {
      existing.updatedAt = status.LastUpdateTime;
    }
    byStation.set(stationId, existing);
  }
  return byStation;
}

function addressLine(address: TdxAddress | undefined): string | undefined {
  if (!address) return undefined;
  const parts = [
    cleanString(address.Road),
    address.Lane ? `${cleanString(address.Lane)}巷` : undefined,
    address.Alley ? `${cleanString(address.Alley)}弄` : undefined,
    address.No ? `${cleanString(address.No)}號` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("") : undefined;
}

function buildConnectors(station: TdxStation): EvChargingStation["connectors"] {
  return (station.Connectors ?? [])
    .filter((c) => c.Quantity === undefined || c.Quantity > 0)
    .map((c) =>
      connector({
        type: c.Type !== undefined ? (CONNECTOR_TYPE_LABELS[c.Type] ?? "Unknown") : undefined,
        currentType: c.Power !== undefined ? CURRENT_TYPE_LABELS[c.Power] : undefined,
        quantity: c.Quantity,
      }),
    );
}

function stationToCanonical(
  city: string,
  station: TdxStation,
  availability: EvseAvailability | undefined,
): EvChargingStation | null {
  const stationId = cleanString(station.StationID);
  const lat =
    typeof station.PositionLat === "number" ? station.PositionLat : Number(station.PositionLat);
  const lng =
    typeof station.PositionLon === "number" ? station.PositionLon : Number(station.PositionLon);
  if (!stationId || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const id = `${STATION_PREFIX}${city}:${stationId}`;
  const address = station.Location?.Address;
  const parkingRate = cleanString(station.ParkingRate);

  return {
    id,
    sources: [SOURCE_ID],
    sourceItemIds: [id],
    name:
      cleanString(station.StationName?.En) ??
      cleanString(station.StationName?.Zh_tw) ??
      "EV Charging Station",
    coordinates: [lng, lat],
    address: {
      line1: addressLine(address),
      town: cleanString(address?.Town),
      state: cleanString(address?.City),
      country: "Taiwan",
    },
    status: "unknown",
    availability,
    isLive: Boolean(availability),
    usageType: "Public",
    usageCost: cleanString(station.ChargingRate),
    openingHours: cleanString(station.ServiceTime),
    connectors: buildConnectors(station),
    notes: parkingRate ? [`Parking: ${parkingRate}`] : undefined,
    updatedAt: availability?.updatedAt,
    sourceUrl: TDX_DATASET_URL,
  };
}

async function searchCity(
  city: string,
  bbox: BoundingBox,
  token: string,
): Promise<EvChargingStation[]> {
  const stations = await fetchStations(city, positionFilter(bbox), token);
  if (stations.length === 0) return [];
  const availability = await fetchLiveStatusByStation(city, token);
  return stations
    .map((station) => stationToCanonical(city, station, availability.get(station.StationID ?? "")))
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function searchTwTdxCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!hasCredentials() || !bboxOverlaps(bbox, COVERAGE)) return [];
  const cities = overlappingCities(bbox);
  if (cities.length === 0) return [];
  const token = await getAccessToken();
  if (!token) return [];

  const perCity = await Promise.all(cities.map((city) => searchCity(city, bbox, token)));
  return perCity.flat();
}

export async function fetchTwTdxChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  if (!hasCredentials()) return null;
  const rest = itemId.startsWith(STATION_PREFIX) ? itemId.slice(STATION_PREFIX.length) : itemId;
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const city = rest.slice(0, sep);
  const stationId = rest.slice(sep + 1);
  if (!city || !stationId || !CITY_BBOXES[city]) return null;

  const token = await getAccessToken();
  if (!token) return null;

  const stations = await fetchStations(
    city,
    `StationID eq '${escapeODataString(stationId)}'`,
    token,
  );
  const match = stations.find((s) => cleanString(s.StationID) === stationId);
  if (!match) return null;

  const availability = await fetchLiveStatusByStation(city, token);
  return stationToCanonical(city, match, availability.get(stationId));
}

export const twTdxSource: EvChargingSource = {
  id: SOURCE_ID,
  priority: getEvChargingSourcePriority(SOURCE_ID),
  search: searchTwTdxCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_PREFIX),
  fetchDetail: fetchTwTdxChargingDetail,
};
