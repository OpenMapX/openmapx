import { type BoundingBox, fetchJson } from "@openmapx/core";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  joinAddress,
  parseInteger,
  parseLocalizedNumber,
} from "./utils.js";

interface NobilAttrValue {
  attrname?: string;
  trans?: string;
  attrval?: string | boolean;
}

interface NobilStationEnvelope {
  csmd?: NobilStationMetadata;
  attr?: {
    st?: Record<string, NobilAttrValue>;
    conn?: Record<string, NobilAttrValue>;
  };
}

interface NobilStationMetadata {
  id?: number | string;
  name?: string;
  Active?: boolean;
  active?: boolean;
  Street?: string;
  House_number?: string;
  Zipcode?: string;
  City?: string;
  County?: string;
  Position?: string;
  geolocation?: string;
  Description_of_location?: string;
  Owned_by?: string;
  owner?: string;
  Number_charging_points?: number | string;
  chargerpointnumber?: number | string;
  Available_charging_points?: number | string;
  Station_status?: number | string;
  International_id?: string;
  url?: string;
  User_comment?: string;
  usercomment?: string;
  Contact_info?: string;
  contactinfo?: string;
  Updated?: string;
  updated?: string;
  Land_code?: string;
  countrycode?: string;
}

const SEARCH_URL = "https://nobil.no/api/server/search.php";
const DATASET_URL = "https://info.nobil.no/api";
const COVERAGE = { south: 54.5, west: 4, north: 72.5, east: 32 };
const LIMIT = 2000;

let nobilApiKey: string | undefined;

export function setNobilApiKey(value: string | undefined): void {
  nobilApiKey = value && value.length > 0 ? value : undefined;
}

function parsePosition(value: string | undefined): [number, number] | null {
  const match = value?.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lng, lat];
}

function attrByName(
  attrs: Record<string, NobilAttrValue> | undefined,
  name: string,
): NobilAttrValue | undefined {
  const lower = name.toLowerCase();
  return Object.values(attrs ?? {}).find((attr) => attr.attrname?.toLowerCase() === lower);
}

function attrText(
  attrs: Record<string, NobilAttrValue> | undefined,
  name: string,
): string | undefined {
  const attr = attrByName(attrs, name);
  return cleanString(attr?.trans) ?? cleanString(String(attr?.attrval ?? ""));
}

function powerFromCapacity(value: string | undefined): number | undefined {
  if (!value || !/kw/i.test(value)) return undefined;
  return parseLocalizedNumber(value);
}

function statusFromStation(csmd: NobilStationMetadata): EvChargingStation["status"] {
  if (csmd.Active === false || csmd.active === false) return "not-operational";
  const status = String(csmd.Station_status ?? "");
  if (status === "1") return "operational";
  if (status.length > 0 && status !== "1") return "not-operational";
  return "unknown";
}

function metadataFromFlat(value: unknown): NobilStationEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as NobilStationMetadata & { csmd?: NobilStationMetadata };
  if (obj.csmd) return obj as NobilStationEnvelope;
  if (obj.id || obj.International_id) return { csmd: obj };
  return null;
}

function extractStations(value: unknown): NobilStationEnvelope[] {
  if (!Array.isArray(value)) return [];
  const out: NobilStationEnvelope[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as { chargerstations?: unknown[] };
    if (Array.isArray(obj.chargerstations)) {
      out.push(
        ...obj.chargerstations
          .map(metadataFromFlat)
          .filter((s): s is NobilStationEnvelope => Boolean(s)),
      );
      continue;
    }
    const flat = metadataFromFlat(entry);
    if (flat) out.push(flat);
  }
  return out;
}

function stationToCanonical(envelope: NobilStationEnvelope): EvChargingStation | null {
  const csmd = envelope.csmd;
  if (!csmd) return null;
  const id = cleanString(csmd.International_id) ?? cleanString(String(csmd.id ?? ""));
  const numericId = cleanString(String(csmd.id ?? ""));
  const coordinates = parsePosition(csmd.Position ?? csmd.geolocation);
  if (!id || !coordinates) return null;

  const stationAttrs = envelope.attr?.st;
  const connectorAttrs = envelope.attr?.conn;
  const connectorType = attrText(connectorAttrs, "Connector") ?? "Unknown";
  const capacity = attrText(connectorAttrs, "Charging capacity");
  const quantity = parseInteger(csmd.Number_charging_points ?? csmd.chargerpointnumber);
  const open24h = attrText(stationAttrs, "Open 24h");
  const operatorName = cleanString(csmd.Owned_by ?? csmd.owner);
  const access =
    attrText(stationAttrs, "Availability") ??
    attrText(connectorAttrs, "Accessability") ??
    cleanString(csmd.Description_of_location);
  const notes = [
    cleanString(csmd.User_comment ?? csmd.usercomment),
    cleanString(csmd.Contact_info ?? csmd.contactinfo),
  ].filter((value): value is string => Boolean(value));

  return {
    id: `nobil:${id}`,
    sources: ["nobil"],
    sourceItemIds: [`nobil:${id}`, numericId ? `nobil:${numericId}` : undefined].filter(
      (value): value is string => Boolean(value),
    ),
    name: cleanString(csmd.name) ?? "EV Charging Station",
    coordinates,
    address: {
      line1: joinAddress([cleanString(csmd.Street), cleanString(csmd.House_number)]),
      town: cleanString(csmd.City),
      state: cleanString(csmd.County),
      postcode: cleanString(csmd.Zipcode),
      country: cleanString(csmd.Land_code ?? csmd.countrycode),
    },
    operator: operatorName ? { name: operatorName } : undefined,
    status: statusFromStation(csmd),
    usageType: access,
    openingHours: open24h?.toLowerCase() === "yes" ? "24/7" : undefined,
    access,
    connectors: [
      connector({
        type: connectorType,
        powerKw: powerFromCapacity(capacity),
        quantity,
      }),
    ],
    updatedAt: cleanString(csmd.Updated ?? csmd.updated),
    sourceUrl: cleanString(csmd.url) ?? DATASET_URL,
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function fetchNobil(params: URLSearchParams): Promise<unknown> {
  if (!nobilApiKey) return [];
  return fetchJson(`${SEARCH_URL}?${params.toString()}`, {
    errorMessage: ({ status }) => `NOBIL API error: ${status}`,
  });
}

export async function searchNobilCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!nobilApiKey || !bboxOverlaps(bbox, COVERAGE)) return [];
  const params = new URLSearchParams({
    apikey: nobilApiKey,
    apiversion: "3",
    action: "search",
    type: "rectangle",
    northeast: `(${bbox.north}, ${bbox.east})`,
    southwest: `(${bbox.south}, ${bbox.west})`,
    limit: String(LIMIT),
    format: "json",
  });
  const data = await fetchNobil(params);
  return extractStations(data)
    .map(stationToCanonical)
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchNobilChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  if (!nobilApiKey) return null;
  const id = itemId.startsWith("nobil:") ? itemId.slice("nobil:".length) : itemId;
  const params = new URLSearchParams({
    apikey: nobilApiKey,
    apiversion: "3",
    action: "search",
    type: "id",
    id,
    format: "json",
  });
  const data = await fetchNobil(params);
  return (
    extractStations(data)
      .map(stationToCanonical)
      .find((station): station is EvChargingStation => Boolean(station)) ?? null
  );
}

export const nobilSource: EvChargingSource = {
  id: "nobil",
  priority: getEvChargingSourcePriority("nobil"),
  search: searchNobilCharging,
  canFetchDetail: (itemId) => itemId.startsWith("nobil:"),
  fetchDetail: fetchNobilChargingDetail,
};
