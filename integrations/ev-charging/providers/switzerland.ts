import { type BoundingBox, fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import type {
  EvChargingConnector,
  EvChargingSource,
  EvChargingStation,
} from "@openmapx/mobility-core/ev-charging";
import { deduplicateChargingStations } from "./dedup.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  parseLocalizedNumber,
  uniqueStrings,
} from "./utils.js";

interface SwissEvseDataGroup {
  OperatorID?: string;
  OperatorName?: string;
  EVSEDataRecord?: SwissEvseRecord[];
}

interface SwissEvseFeed {
  EVSEData?: SwissEvseDataGroup[];
}

interface SwissAddress {
  Street?: string;
  City?: string;
  PostalCode?: string;
  Country?: string;
  Region?: string;
}

interface SwissChargingFacility {
  Amperage?: number;
  Voltage?: number;
  power?: number;
  powertype?: string;
}

interface SwissEvseRecord {
  Accessibility?: string;
  AccessibilityLocation?: string;
  Address?: SwissAddress;
  AuthenticationModes?: string[];
  ChargingFacilities?: SwissChargingFacility[];
  ChargingStationId?: string;
  ChargingStationNames?: Array<{ lang?: string; value?: string }>;
  DynamicInfoAvailable?: boolean;
  EvseID?: string;
  GeoCoordinates?: { Google?: string };
  HotlinePhoneNumber?: string;
  IsOpen24Hours?: boolean;
  Plugs?: string[];
  RenewableEnergy?: boolean;
  lastUpdate?: string;
}

interface SwissStatusGroup {
  EVSEStatusRecord?: Array<{ EvseID?: string; EVSEStatus?: string }>;
}

interface SwissStatusFeed {
  EVSEStatuses?: SwissStatusGroup[];
}

const DATA_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/oicp/ch.bfe.ladestellen-elektromobilitaet.json";
const STATUS_URL =
  "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/status/oicp/ch.bfe.ladestellen-elektromobilitaet.json";
const DATASET_URL = "https://opendata.swiss/en/dataset/ladestationen-fuer-elektroautos";
const COVERAGE = { south: 45.8, west: 5.9, north: 47.9, east: 10.6 };
const CACHE_TTL_MS = 10 * 60 * 1000;

let stationsCache: { expiresAt: number; stations: EvChargingStation[] } | null = null;

function parseGoogleCoordinates(value: string | undefined): [number, number] | null {
  const parts = value?.trim().split(/\s+/) ?? [];
  if (parts.length < 2) return null;
  const lat = parseLocalizedNumber(parts[0]);
  const lng = parseLocalizedNumber(parts[1]);
  if (lat === undefined || lng === undefined) return null;
  return [lng, lat];
}

function preferredName(record: SwissEvseRecord): string | undefined {
  const names = record.ChargingStationNames ?? [];
  return (
    cleanString(names.find((name) => name.lang === "en")?.value) ??
    cleanString(names.find((name) => name.lang === "de")?.value) ??
    cleanString(names.find((name) => name.lang === "fr")?.value) ??
    cleanString(names[0]?.value)
  );
}

function maxFacilityPower(record: SwissEvseRecord): number | undefined {
  const powers = (record.ChargingFacilities ?? [])
    .map((facility) => facility.power)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (powers.length > 0) return Math.max(...powers);

  const calculated = (record.ChargingFacilities ?? [])
    .map((facility) =>
      facility.Voltage && facility.Amperage ? (facility.Voltage * facility.Amperage) / 1000 : 0,
    )
    .filter((value) => value > 0);
  return calculated.length > 0 ? Math.max(...calculated) : undefined;
}

function stationStatus(status: string | undefined): EvChargingStation["status"] {
  const upper = status?.toUpperCase() ?? "";
  if (["AVAILABLE", "CHARGING", "BLOCKED", "RESERVED"].includes(upper)) return "operational";
  if (["PLANNED"].includes(upper)) return "planned";
  if (["INOPERATIVE", "OUTOFORDER", "REMOVED"].includes(upper)) return "not-operational";
  return "unknown";
}

function recordConnectors(
  record: SwissEvseRecord,
  statuses: Map<string, string>,
): EvChargingConnector[] {
  const plugs = record.Plugs ?? [];
  const powerKw = maxFacilityPower(record);
  const status = statuses.get(record.EvseID ?? "");
  if (plugs.length === 0 && powerKw) {
    return [
      connector({
        type: "Unknown",
        powerKw,
        status,
        reference: record.EvseID,
      }),
    ];
  }
  return plugs.map((plug) =>
    connector({
      type: plug,
      powerKw,
      status,
      reference: record.EvseID,
    }),
  );
}

function recordToStation(
  group: SwissEvseDataGroup,
  record: SwissEvseRecord,
  statuses: Map<string, string>,
): EvChargingStation | null {
  const coordinates = parseGoogleCoordinates(record.GeoCoordinates?.Google);
  const stationId = cleanString(record.ChargingStationId) ?? cleanString(record.EvseID);
  if (!coordinates || !stationId) return null;

  const encodedStationId = encodeURIComponent(stationId);
  const encodedEvseId = record.EvseID ? encodeURIComponent(record.EvseID) : undefined;
  const status = statuses.get(record.EvseID ?? "");
  const operatorName = cleanString(group.OperatorName) ?? cleanString(group.OperatorID);
  const notes = [
    record.DynamicInfoAvailable ? "Dynamic status available" : undefined,
    record.RenewableEnergy ? "Renewable energy" : undefined,
    record.HotlinePhoneNumber ? `Hotline: ${record.HotlinePhoneNumber}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    id: `swiss-sfoe:${encodedStationId}`,
    sources: ["swiss-sfoe"],
    sourceItemIds: [
      `swiss-sfoe:${encodedStationId}`,
      encodedEvseId ? `swiss-sfoe:${encodedEvseId}` : undefined,
    ].filter((value): value is string => Boolean(value)),
    name: preferredName(record) ?? "EV Charging Station",
    coordinates,
    address: {
      line1: cleanString(record.Address?.Street),
      town: cleanString(record.Address?.City),
      state: cleanString(record.Address?.Region),
      postcode: cleanString(record.Address?.PostalCode),
      country: cleanString(record.Address?.Country) ?? "Switzerland",
    },
    operator: operatorName ? { name: operatorName } : undefined,
    status: stationStatus(status),
    usageType: cleanString(record.Accessibility),
    openingHours: record.IsOpen24Hours ? "24/7" : undefined,
    access: cleanString(record.AccessibilityLocation),
    paymentMethods: record.AuthenticationModes,
    connectors: recordConnectors(record, statuses),
    updatedAt: cleanString(record.lastUpdate),
    sourceUrl: DATASET_URL,
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function fetchStatusMap(): Promise<Map<string, string>> {
  try {
    const response = await fetchWithRedirects(STATUS_URL, {
      allowedRedirectHosts: ["data.geo.admin.ch", "*.geo.admin.ch"],
      headers: {
        "Accept-Encoding": "gzip, br, deflate",
        "User-Agent": USER_AGENT,
      },
      timeoutMs: 20_000,
    });
    if (!response.ok) return new Map();
    const feed = (await response.json()) as SwissStatusFeed;
    const map = new Map<string, string>();
    for (const group of feed.EVSEStatuses ?? []) {
      for (const record of group.EVSEStatusRecord ?? []) {
        if (record.EvseID && record.EVSEStatus) map.set(record.EvseID, record.EVSEStatus);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function fetchAllStations(): Promise<EvChargingStation[]> {
  if (stationsCache && stationsCache.expiresAt > Date.now()) return stationsCache.stations;

  const [response, statuses] = await Promise.all([
    fetchWithRedirects(DATA_URL, {
      allowedRedirectHosts: ["data.geo.admin.ch", "*.geo.admin.ch"],
      headers: {
        "Accept-Encoding": "gzip, br, deflate",
        "User-Agent": USER_AGENT,
      },
      timeoutMs: 30_000,
    }),
    fetchStatusMap(),
  ]);
  if (!response.ok) {
    if (stationsCache) return stationsCache.stations;
    throw new Error(`Swiss SFOE EV feed failed: ${response.status}`);
  }

  const feed = (await response.json()) as SwissEvseFeed;
  const stations = deduplicateChargingStations(
    (feed.EVSEData ?? []).flatMap((group) =>
      (group.EVSEDataRecord ?? [])
        .map((record) => recordToStation(group, record, statuses))
        .filter((station): station is EvChargingStation => Boolean(station)),
    ),
  ).map((station) => ({
    ...station,
    paymentMethods: uniqueStrings([station.paymentMethods]),
  }));

  stationsCache = { expiresAt: Date.now() + CACHE_TTL_MS, stations };
  return stations;
}

export async function searchSwissSfoeCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!bboxOverlaps(bbox, COVERAGE)) return [];
  const stations = await fetchAllStations();
  return stations.filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchSwissSfoeChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const stations = await fetchAllStations();
  return stations.find((station) => station.sourceItemIds?.includes(itemId)) ?? null;
}

export const swissSfoeSource: EvChargingSource = {
  id: "swiss-sfoe",
  priority: getEvChargingSourcePriority("swiss-sfoe"),
  search: searchSwissSfoeCharging,
  canFetchDetail: (itemId) => itemId.startsWith("swiss-sfoe:"),
  fetchDetail: fetchSwissSfoeChargingDetail,
};
