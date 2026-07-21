import { fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger } from "@openmapx/poi-source-registry";
import { parseDelimited, rowsToObjects } from "./csv.js";
import {
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

function rowValue(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cleanString(row[key]);
    if (value) return value;
  }
  return undefined;
}

function statusFromText(value: string | undefined): string {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("außer") || lower.includes("ausser")) return "not-operational";
  if (lower.includes("nicht")) return "not-operational";
  if (lower.includes("planung") || lower.includes("bau")) return "planned";
  if (lower.includes("betrieb")) return "operational";
  return "unknown";
}

function getConnectors(row: Record<string, string>): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];
  for (let i = 1; i <= 6; i++) {
    const types = splitList(rowValue(row, `Steckertypen${i}`));
    const powers = splitList(rowValue(row, `Nennleistung Stecker${i}`));
    const evseIds = splitList(rowValue(row, `EVSE-ID${i}`));

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

export function* parseDeBnetzaCsv(buffer: Buffer): Iterable<PoiRow> {
  const text = new TextDecoder("windows-1252").decode(buffer);
  const rows = parseDelimited(text, ";");
  const headerIndex = rows.findIndex((row) => row[0] === "Ladeeinrichtungs-ID");
  if (headerIndex < 0) return;

  for (const row of rowsToObjects(rows, headerIndex)) {
    const id = rowValue(row, "Ladeeinrichtungs-ID");
    const lat = parseLocalizedNumber(rowValue(row, "Breitengrad"));
    const lng = parseLocalizedNumber(rowValue(row, "Längengrad"));
    if (!id || lat === undefined || lng === undefined) continue;

    const operator = rowValue(row, "Betreiber");
    const displayName =
      rowValue(row, "Anzeigename (Karte)") ??
      rowValue(row, "Standortbezeichnung") ??
      operator ??
      "EV Charging Station";
    const paymentMethods = splitList(rowValue(row, "Bezahlsysteme"));

    yield {
      poiId: id,
      lng,
      lat,
      payload: {
        // Coordinates duplicated in payload: the reader hands the mapper only
        // (poiId, payload) — geom is used for the SQL bbox filter, not returned.
        coordinates: [lng, lat] as [number, number],
        name: displayName,
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
      },
    };
  }
}

export async function resolveDeBnetzaCsvUrl(log: PoiSourceLogger): Promise<string> {
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
    if (url) return url;
    log.warn("de-bnetza-parser: scraped page contained no CSV URL — using fallback");
  } catch (err) {
    log.warn(`de-bnetza-parser: scrape failed (${(err as Error).message}) — using fallback`);
  }
  return FALLBACK_CSV_URL;
}
