import { type BoundingBox, fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import type {
  EvChargingConnector,
  EvChargingSource,
  EvChargingStation,
} from "@openmapx/mobility-core/ev-charging";
import { parseDelimited, rowsToObjects } from "./csv.js";
import { deduplicateChargingStations } from "./dedup.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import {
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  joinAddress,
  parseInteger,
  parseLocalizedNumber,
  splitList,
} from "./utils.js";

const DATASET_PAGE_URL =
  "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/DownloadundKontakt.html";
const FALLBACK_CSV_URL =
  "https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-04-22.csv";
const COVERAGE = { south: 47.1, west: 5.5, north: 55.2, east: 15.6 };
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let csvUrlCache: { expiresAt: number; url: string } | null = null;
let stationsCache: { expiresAt: number; stations: EvChargingStation[] } | null = null;

function rowValue(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cleanString(row[key]);
    if (value) return value;
  }
  return undefined;
}

function statusFromText(value: string | undefined): EvChargingStation["status"] {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("außer") || lower.includes("ausser")) return "not-operational";
  if (lower.includes("nicht")) return "not-operational";
  if (lower.includes("planung") || lower.includes("bau")) return "planned";
  if (lower.includes("betrieb")) return "operational";
  return "unknown";
}

function splitAligned(value: string | undefined): string[] {
  return splitList(value);
}

function getConnectors(row: Record<string, string>): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];
  for (let i = 1; i <= 6; i++) {
    const types = splitAligned(rowValue(row, `Steckertypen${i}`));
    const powers = splitAligned(rowValue(row, `Nennleistung Stecker${i}`));
    const evseIds = splitAligned(rowValue(row, `EVSE-ID${i}`));

    for (let j = 0; j < types.length; j++) {
      connectors.push(
        connector({
          type: types[j],
          powerKw: parseLocalizedNumber(powers[j] ?? powers[0]),
          quantity: 1,
          reference: evseIds[j] ?? evseIds[0],
        }),
      );
    }
  }

  if (connectors.length === 0) {
    const quantity = parseInteger(rowValue(row, "Anzahl Ladepunkte"));
    const powerKw = parseLocalizedNumber(rowValue(row, "Nennleistung Ladeeinrichtung [kW]"));
    if (quantity || powerKw) {
      connectors.push(connector({ type: "Unknown", powerKw, quantity }));
    }
  }
  return connectors;
}

function openingHours(row: Record<string, string>): string | undefined {
  const raw = rowValue(row, "Öffnungszeiten");
  if (raw === "247") return "24/7";
  const days = rowValue(row, "Öffnungszeiten: Wochentage");
  const times = rowValue(row, "Öffnungszeiten: Tageszeiten");
  if (days && times) return `${days}: ${times}`;
  return raw;
}

function rowToStation(row: Record<string, string>): EvChargingStation | null {
  const id = rowValue(row, "Ladeeinrichtungs-ID");
  const lat = parseLocalizedNumber(rowValue(row, "Breitengrad"));
  const lng = parseLocalizedNumber(rowValue(row, "Längengrad"));
  if (!id || lat === undefined || lng === undefined) return null;

  const operator = rowValue(row, "Betreiber");
  const displayName =
    rowValue(row, "Anzeigename (Karte)") ??
    rowValue(row, "Standortbezeichnung") ??
    operator ??
    "EV Charging Station";
  const paymentMethods = splitList(rowValue(row, "Bezahlsysteme"));

  return {
    id: `bnetza:${id}`,
    sources: ["bnetza"],
    sourceItemIds: [`bnetza:${id}`],
    name: displayName,
    coordinates: [lng, lat],
    address: {
      line1: joinAddress([rowValue(row, "Straße"), rowValue(row, "Hausnummer")]),
      town: rowValue(row, "Ort"),
      state: rowValue(row, "Bundesland"),
      postcode: rowValue(row, "Postleitzahl"),
      country: "Germany",
    },
    operator: operator ? { name: operator } : undefined,
    status: statusFromText(rowValue(row, "Status")),
    usageType: rowValue(row, "Art der Ladeeinrichtung"),
    usageCost: paymentMethods.includes("Kostenlos") ? "Free" : undefined,
    openingHours: openingHours(row),
    access: rowValue(row, "Informationen zum Parkraum"),
    paymentMethods: paymentMethods.length > 0 ? paymentMethods : undefined,
    connectors: getConnectors(row),
    updatedAt: rowValue(row, "Inbetriebnahmedatum"),
    sourceUrl: DATASET_PAGE_URL,
  };
}

async function resolveCsvUrl(): Promise<string> {
  if (csvUrlCache && csvUrlCache.expiresAt > Date.now()) return csvUrlCache.url;
  try {
    const response = await fetchWithRedirects(DATASET_PAGE_URL, {
      allowedRedirectHosts: ["www.bundesnetzagentur.de", "*.bundesnetzagentur.de"],
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: 20_000,
    });
    if (!response.ok) throw new Error(`BNetzA page failed: ${response.status}`);
    const html = await response.text();
    const matches = [
      ...html.matchAll(
        /https:\/\/data\.bundesnetzagentur\.de\/[^"'<>\s]+Ladesaeulenregister_BNetzA_\d{4}-\d{2}-\d{2}\.csv/gi,
      ),
    ].map((match) => match[0]);
    const url = matches.sort().at(-1);
    if (url) {
      csvUrlCache = { expiresAt: Date.now() + CACHE_TTL_MS, url };
      return url;
    }
  } catch {
    // Fall back to the latest URL verified when this integration was added.
  }
  csvUrlCache = { expiresAt: Date.now() + CACHE_TTL_MS, url: FALLBACK_CSV_URL };
  return FALLBACK_CSV_URL;
}

async function fetchAllStations(): Promise<EvChargingStation[]> {
  if (stationsCache && stationsCache.expiresAt > Date.now()) return stationsCache.stations;

  const url = await resolveCsvUrl();
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: ["data.bundesnetzagentur.de", "*.bundesnetzagentur.de"],
    headers: { Accept: "text/csv,*/*", "User-Agent": USER_AGENT },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (stationsCache) return stationsCache.stations;
    throw new Error(`BNetzA CSV failed: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const text = new TextDecoder("windows-1252").decode(buffer);
  const rows = parseDelimited(text, ";");
  const headerIndex = rows.findIndex((row) => row[0] === "Ladeeinrichtungs-ID");
  const stations = deduplicateChargingStations(
    rowsToObjects(rows, headerIndex)
      .map(rowToStation)
      .filter((station): station is EvChargingStation => Boolean(station)),
  );

  stationsCache = { expiresAt: Date.now() + CACHE_TTL_MS, stations };
  return stations;
}

export async function searchBnetzaCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!bboxOverlaps(bbox, COVERAGE)) return [];
  const stations = await fetchAllStations();
  return stations.filter((station) => bboxContainsCoordinates(bbox, station.coordinates));
}

export async function fetchBnetzaChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const stations = await fetchAllStations();
  return stations.find((station) => station.sourceItemIds?.includes(itemId)) ?? null;
}

export const bnetzaSource: EvChargingSource = {
  id: "bnetza",
  priority: getEvChargingSourcePriority("bnetza"),
  search: searchBnetzaCharging,
  canFetchDetail: (itemId) => itemId.startsWith("bnetza:"),
  fetchDetail: fetchBnetzaChargingDetail,
};
