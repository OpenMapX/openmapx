import { readBoundedBinaryResponse } from "@openmapx/core/server";
import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { cleanString, connector, parseInteger, parseLocalizedNumber, splitList } from "./utils.js";

/**
 * Italy PUN (Piattaforma Unica Nazionale — GSE/MASE) parser. ArcGIS
 * FeatureServer GeoJSON, no auth. The feed is EVSE/connector-level
 * (~48.9k rows): every physical connector is its own feature, with
 * multiple features sharing the same `ID_location` for a multi-connector
 * site. This groups by `ID_location` into one station row per site,
 * merging every feature's connector(s) into that station.
 *
 * `data-manager` pre-fetches page 1 (2000 rows) as `seed`; this pages the
 * rest internally via `globalThis.fetch` following `resultOffset` until a
 * page returns fewer than `resultRecordCount` features.
 */

export const IT_PUN_URL =
  "https://services-eu1.arcgis.com/iIOeNeT2w8BczYEP/arcgis/rest/services/PdR_latest_ready/FeatureServer/0/query?where=1=1&outFields=*&f=geojson&resultRecordCount=2000";

const SOURCE_URL = "https://www.piattaformaunicanazionale.it/idr";
const PAGE_SIZE = 2000;
const PAGE_TIMEOUT_MS = 30_000;
// ~48.9k EVSE rows at 2000/page is ~25 pages; cap well above so a runaway
// feed can't loop forever.
const MAX_PAGES = 100;

const CONNECTOR_TYPE_MAP: Record<string, string> = {
  IEC_62196_T2: "Type 2",
  IEC_62196_T2_COMBO: "CCS (Type 2)",
  CHADEMO: "CHAdeMO",
  IEC_62196_T1: "Type 1",
  DOMESTIC_E: "Schuko",
  DOMESTIC_F: "Schuko",
  TESLA_R: "Tesla",
  TESLA_S: "Tesla",
};

const OPERATIONAL_STATES = new Set(["AVAILABLE", "CHARGING"]);
const NOT_OPERATIONAL_STATES = new Set(["OUTOFORDER", "INOPERATIVE"]);

interface ItPunFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

interface ItPunFeatureCollection {
  features?: ItPunFeature[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePage(buffer: Buffer): ItPunFeature[] {
  let data: ItPunFeatureCollection;
  try {
    data = JSON.parse(buffer.toString("utf8")) as ItPunFeatureCollection;
  } catch {
    return [];
  }
  return Array.isArray(data?.features) ? data.features : [];
}

/**
 * Collects every EVSE feature from the paginated FeatureServer query. `seed`
 * is the fetch stage's page 1; subsequent pages are fetched here directly
 * via `resultOffset` until a page returns fewer than `PAGE_SIZE` features.
 */
async function fetchAllFeatures(seed: Buffer, log: PoiSourceLogger): Promise<ItPunFeature[]> {
  const all: ItPunFeature[] = [];
  let page = parsePage(seed);
  all.push(...page);
  let offset = page.length;
  let pages = 0;

  while (page.length >= PAGE_SIZE) {
    if (pages >= MAX_PAGES) {
      log.warn(`it-pun-parser: page cap (${MAX_PAGES}) hit — data truncated`);
      break;
    }
    pages += 1;
    try {
      const res = await globalThis.fetch(`${IT_PUN_URL}&resultOffset=${offset}`, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.error(`it-pun-parser: HTTP ${res.status} at offset ${offset} — returning partial`);
        break;
      }
      const { data: buffer } = await readBoundedBinaryResponse(res, {
        maxBytes: 32 * 1024 * 1024,
        fallbackContentType: "application/json",
        label: "Italian PUN charging page",
      });
      page = parsePage(buffer);
      all.push(...page);
      offset += page.length;
    } catch (err) {
      log.error(
        `it-pun-parser: fetch failed at offset ${offset} (${(err as Error).message}) — returning partial`,
      );
      break;
    }
  }
  return all;
}

function featureConnectors(props: Record<string, unknown>): EvChargingConnector[] {
  const standards = splitList(str(props.Standard_del_connettore));
  const watts = parseLocalizedNumber(props.Potenza_erogabile);
  const powerKw = watts !== undefined ? watts / 1000 : undefined;
  const alimentazione = str(props.Tipologia_di_alimentazione);
  const currentType = alimentazione?.startsWith("AC")
    ? "AC"
    : alimentazione?.startsWith("DC")
      ? "DC"
      : undefined;
  const quantity = parseInteger(props.Numero_Connettori) ?? 1;

  const types = standards.length > 0 ? standards : ["Unknown"];
  return types.map((standard) =>
    connector({
      type: CONNECTOR_TYPE_MAP[standard] ?? "Unknown",
      powerKw,
      currentType,
      quantity,
    }),
  );
}

function rollupStatus(states: string[]): "operational" | "not-operational" | "unknown" {
  if (states.length === 0) return "unknown";
  if (states.some((s) => OPERATIONAL_STATES.has(s))) return "operational";
  if (states.every((s) => NOT_OPERATIONAL_STATES.has(s))) return "not-operational";
  return "unknown";
}

interface StationAccumulator {
  lng: number;
  lat: number;
  name?: string;
  indirizzo?: string;
  town?: string;
  postcode?: string;
  provincia?: string;
  openingHours?: string;
  states: string[];
  connectors: EvChargingConnector[];
  latestUpdatedMs?: number;
}

function* groupByLocation(features: ItPunFeature[]): Iterable<PoiRow> {
  const stations = new Map<string, StationAccumulator>();
  const order: string[] = [];

  for (const feature of features) {
    const props = feature.properties ?? {};
    const coords = feature.geometry?.coordinates;
    const poiId = cleanString(str(props.ID_location));
    if (!poiId || !Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords;
    if (typeof lng !== "number" || typeof lat !== "number") continue;

    let station = stations.get(poiId);
    if (!station) {
      station = {
        lng,
        lat,
        name: cleanString(str(props.Nome_location)) ?? cleanString(str(props.Indirizzo)),
        indirizzo: cleanString(str(props.Indirizzo)),
        town: cleanString(str(props.Città)) ?? cleanString(str(props.Comune)),
        postcode: cleanString(str(props.Codice_postale)),
        provincia: cleanString(str(props.Provincia)),
        openingHours: cleanString(str(props.Orario_d_apertura)),
        states: [],
        connectors: [],
      };
      stations.set(poiId, station);
      order.push(poiId);
    }

    const stato = cleanString(str(props.Stato));
    if (stato) station.states.push(stato);
    station.connectors.push(...featureConnectors(props));

    const updated = parseInteger(props.Data_ultimo_aggiornamento);
    if (
      updated !== undefined &&
      (station.latestUpdatedMs === undefined || updated > station.latestUpdatedMs)
    ) {
      station.latestUpdatedMs = updated;
    }
  }

  for (const poiId of order) {
    const station = stations.get(poiId);
    if (!station) continue;
    yield {
      poiId,
      lng: station.lng,
      lat: station.lat,
      payload: {
        coordinates: [station.lng, station.lat] as [number, number],
        name: station.name ?? "EV Charging Station",
        address: {
          line1: station.indirizzo,
          town: station.town,
          postcode: station.postcode,
          state: station.provincia,
          country: "Italy",
        },
        status: rollupStatus(station.states),
        connectors: station.connectors,
        openingHours: station.openingHours,
        updatedAt:
          station.latestUpdatedMs !== undefined
            ? new Date(station.latestUpdatedMs).toISOString()
            : undefined,
        sourceUrl: SOURCE_URL,
      },
    };
  }
}

async function* iterate(seed: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  const features = await fetchAllFeatures(seed, log);
  yield* groupByLocation(features);
}

export const parseItPun: PoiStaticParseFn = (buffer, { log }) => iterate(buffer, log);
