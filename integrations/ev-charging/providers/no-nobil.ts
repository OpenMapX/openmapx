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

interface NoNobilAttrValue {
  attrname?: string;
  trans?: string;
  attrval?: string | boolean;
}

interface NoNobilStationEnvelope {
  csmd?: NoNobilStationMetadata;
  attr?: {
    st?: Record<string, NoNobilAttrValue>;
    conn?: Record<string, NoNobilAttrValue>;
  };
}

interface NoNobilStationMetadata {
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

let noNobilApiKey: string | undefined;

export function setNoNobilApiKey(value: string | undefined): void {
  noNobilApiKey = value && value.length > 0 ? value : undefined;
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
  attrs: Record<string, NoNobilAttrValue> | undefined,
  name: string,
): NoNobilAttrValue | undefined {
  const lower = name.toLowerCase();
  return Object.values(attrs ?? {}).find((attr) => attr.attrname?.toLowerCase() === lower);
}

function attrText(
  attrs: Record<string, NoNobilAttrValue> | undefined,
  name: string,
): string | undefined {
  const attr = attrByName(attrs, name);
  return cleanString(attr?.trans) ?? cleanString(String(attr?.attrval ?? ""));
}

function powerFromCapacity(value: string | undefined): number | undefined {
  if (!value || !/kw/i.test(value)) return undefined;
  return parseLocalizedNumber(value);
}

function statusFromStation(csmd: NoNobilStationMetadata): EvChargingStation["status"] {
  if (csmd.Active === false || csmd.active === false) return "not-operational";
  const status = String(csmd.Station_status ?? "");
  if (status === "1") return "operational";
  if (status.length > 0 && status !== "1") return "not-operational";
  return "unknown";
}

function metadataFromFlat(value: unknown): NoNobilStationEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as NoNobilStationMetadata & { csmd?: NoNobilStationMetadata };
  if (obj.csmd) return obj as NoNobilStationEnvelope;
  if (obj.id || obj.International_id) return { csmd: obj };
  return null;
}

function extractStations(value: unknown): NoNobilStationEnvelope[] {
  if (!Array.isArray(value)) return [];
  const out: NoNobilStationEnvelope[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as { chargerstations?: unknown[] };
    if (Array.isArray(obj.chargerstations)) {
      out.push(
        ...obj.chargerstations
          .map(metadataFromFlat)
          .filter((s): s is NoNobilStationEnvelope => Boolean(s)),
      );
      continue;
    }
    const flat = metadataFromFlat(entry);
    if (flat) out.push(flat);
  }
  return out;
}

function stationToCanonical(envelope: NoNobilStationEnvelope): EvChargingStation | null {
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
    id: `no-nobil:${id}`,
    sources: ["no-nobil"],
    sourceItemIds: [`no-nobil:${id}`, numericId ? `no-nobil:${numericId}` : undefined].filter(
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

async function fetchNoNobil(params: URLSearchParams): Promise<unknown> {
  if (!noNobilApiKey) return [];
  return fetchJson(`${SEARCH_URL}?${params.toString()}`, {
    errorMessage: ({ status }) => `NOBIL API error: ${status}`,
  });
}

export async function searchNoNobilCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!noNobilApiKey || !bboxOverlaps(bbox, COVERAGE)) return [];
  const params = new URLSearchParams({
    apikey: noNobilApiKey,
    apiversion: "3",
    action: "search",
    type: "rectangle",
    northeast: `(${bbox.north}, ${bbox.east})`,
    southwest: `(${bbox.south}, ${bbox.west})`,
    limit: String(LIMIT),
    format: "json",
  });
  const data = await fetchNoNobil(params);
  return extractStations(data)
    .map(stationToCanonical)
    .filter((station): station is EvChargingStation => Boolean(station))
    .filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchNoNobilChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  if (!noNobilApiKey) return null;
  const id = itemId.startsWith("no-nobil:") ? itemId.slice("no-nobil:".length) : itemId;
  const params = new URLSearchParams({
    apikey: noNobilApiKey,
    apiversion: "3",
    action: "search",
    type: "id",
    id,
    format: "json",
  });
  const data = await fetchNoNobil(params);
  return (
    extractStations(data)
      .map(stationToCanonical)
      .find((station): station is EvChargingStation => Boolean(station)) ?? null
  );
}

export const noNobilSource: EvChargingSource = {
  id: "no-nobil",
  priority: getEvChargingSourcePriority("no-nobil"),
  search: searchNoNobilCharging,
  canFetchDetail: (itemId) => itemId.startsWith("no-nobil:"),
  fetchDetail: fetchNoNobilChargingDetail,
};
