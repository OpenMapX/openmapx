import type {
  EvChargingAddress,
  EvChargingConnector,
  EvChargingStatus,
} from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import {
  fetchEipaFile,
  PL_EIPA_DICTIONARY_URL,
  PL_EIPA_DYNAMIC_URL,
  PL_EIPA_OPERATOR_URL,
  PL_EIPA_POINT_URL,
  PL_EIPA_POOL_URL,
  parseEipaEnvelope,
} from "./pl-eipa-client.js";
import { type EipaPrice, mapEipaDynamicPrices } from "./pl-eipa-tariff.js";
import { createTariffCollector } from "./tariff-collector.js";
import { cleanString, connector, idString, joinAddress, newestIsoString } from "./utils.js";

const SOURCE_URL = "https://eipa.udt.gov.pl";

interface EipaDictionaryEntry {
  id?: number | string;
  name?: string;
  description?: string;
}

interface EipaDictionaryFile {
  connector_interface?: EipaDictionaryEntry[];
}

interface EipaOperator {
  id?: number | string;
  name?: string;
}

interface EipaPool {
  id?: number | string;
  operator_id?: number | string;
  name?: string;
  street?: string;
  house_number?: string;
  house_number_addition?: string;
  postal_code?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  operator_name?: string;
  ts?: string;
}

interface EipaStationLocation {
  city?: string;
  community?: string;
  district?: string;
  province?: string;
}

interface EipaStation {
  id?: number | string;
  pool_id?: number | string;
  // "E" electric, "G" gas (CNG/LNG), "H" hydrogen — only "E" is in scope here.
  type?: string;
  latitude?: number;
  longitude?: number;
  location?: EipaStationLocation;
  ts?: string;
}

interface EipaConnectorEntry {
  interfaces?: Array<number | string>;
  cable_attached?: boolean;
  power?: number;
  ts?: string;
}

interface EipaPoint {
  id?: number | string;
  code?: string;
  station_id?: number | string;
  connectors?: EipaConnectorEntry[];
  ts?: string;
}

interface EipaDynamicStatus {
  // 1 = operationally available, 0 = unavailable (out of service).
  availability?: number;
  // 1 = free/unoccupied, 0 = occupied/in use.
  status?: number;
  ts?: string;
}

interface EipaDynamicEntry {
  point_id?: number | string;
  prices?: EipaPrice[];
  status?: EipaDynamicStatus;
}

// Maps a `connector_interface` dictionary name (e.g. `IEC-62196-T2-F-CABLE`)
// to a human label. Distinct from OCPI's `IEC_62196_T2` enum style (see
// de-ocpdb-parser.ts's mapConnectorStandard), so it needs its own table
// rather than reusing utils.ts's generic `normalizeConnectorType`, which
// matches on spaced substrings ("iec 62196-2") that don't appear in EIPA's
// dash-separated names.
function mapConnectorInterfaceName(name: string | undefined): string {
  switch (name) {
    case "CHADEMO":
      return "CHAdeMO";
    case "IEC-62196-T1":
      return "Type 1";
    case "IEC-62196-T1-COMBO":
      return "CCS (Type 1)";
    case "IEC-62196-T2-F-CABLE":
    case "IEC-62196-T2-F-NOCABLE":
      return "Type 2";
    case "IEC-62196-T2-COMBO":
      return "CCS (Type 2)";
    case "IEC-62196-T3C-F-NOCABLE":
      return "Type 3C";
    case "DOMESTIC-A":
    case "DOMESTIC-E":
    case "DOMESTIC-F":
      return "Schuko";
    case "TESLA":
      return "Tesla";
    default:
      return name ?? "Unknown";
  }
}

function buildConnectorInterfaceNames(rawDictionary: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of rawDictionary) {
    if (!raw || typeof raw !== "object") continue;
    for (const entry of (raw as EipaDictionaryFile).connector_interface ?? []) {
      const id = idString(entry.id);
      const name = cleanString(entry.name);
      if (id && name) map.set(id, name);
    }
  }
  return map;
}

function buildById<T extends { id?: number | string }>(raw: unknown[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = idString((entry as T).id);
    if (id) map.set(id, entry as T);
  }
  return map;
}

function buildPointsByStationId(raw: unknown[]): Map<string, EipaPoint[]> {
  const map = new Map<string, EipaPoint[]>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const point = entry as EipaPoint;
    const stationId = idString(point.station_id);
    if (!stationId) continue;
    const list = map.get(stationId);
    if (list) list.push(point);
    else map.set(stationId, [point]);
  }
  return map;
}

function buildDynamicByPointId(raw: unknown[]): Map<string, EipaDynamicEntry> {
  const map = new Map<string, EipaDynamicEntry>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const dyn = entry as EipaDynamicEntry;
    const pointId = idString(dyn.point_id);
    if (pointId) map.set(pointId, dyn);
  }
  return map;
}

function connectorStatus(status: EipaDynamicStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (status.availability === 0) return "unavailable";
  if (status.status === 1) return "available";
  if (status.status === 0) return "occupied";
  return undefined;
}

// "operational" once ANY point on the station reports operationally
// available (dynamic.status.availability === 1) — matching how the EIPA map
// itself only ever shows operationally-available points. "unknown" when the
// dynamic feed carries nothing for this station yet (rather than assuming
// the worst).
function stationStatus(dynamicEntries: EipaDynamicEntry[]): EvChargingStatus {
  if (dynamicEntries.length === 0) return "unknown";
  return dynamicEntries.some((d) => d.status?.availability === 1)
    ? "operational"
    : "not-operational";
}

function mapStationToRow(
  station: EipaStation,
  poolsById: Map<string, EipaPool>,
  operatorsById: Map<string, EipaOperator>,
  pointsByStationId: Map<string, EipaPoint[]>,
  dynamicByPointId: Map<string, EipaDynamicEntry>,
  connectorInterfaceNames: Map<string, string>,
): PoiRow | null {
  // Only electric stations are in scope for the ev-charging domain — gas
  // (CNG/LNG) and hydrogen stations belong to a fuel-station domain instead.
  if (station.type !== "E") return null;

  const poiId = idString(station.id);
  if (!poiId) return null;

  const pool = poolsById.get(idString(station.pool_id) ?? "");
  // station lat/lng is optional per the reader docs — "opcjonalnie, jeśli
  // brak to należy przyjąć wartość podaną przy bazie" (if absent, fall back
  // to the value given at the pool level).
  const lat = typeof station.latitude === "number" ? station.latitude : pool?.latitude;
  const lng = typeof station.longitude === "number" ? station.longitude : pool?.longitude;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  const operatorName =
    cleanString(pool?.operator_name) ??
    cleanString(operatorsById.get(idString(pool?.operator_id) ?? "")?.name);

  const points = pointsByStationId.get(poiId) ?? [];
  const connectors: EvChargingConnector[] = [];
  const tariffCollector = createTariffCollector();
  const dynamicEntries: EipaDynamicEntry[] = [];

  for (const point of points) {
    const pointId = idString(point.id);
    const dyn = pointId ? dynamicByPointId.get(pointId) : undefined;
    if (dyn) dynamicEntries.push(dyn);

    const status = connectorStatus(dyn?.status);
    const pointConnectors: EvChargingConnector[] = [];
    for (const raw of point.connectors ?? []) {
      const interfaceId = idString(raw.interfaces?.[0]);
      const interfaceName = interfaceId ? connectorInterfaceNames.get(interfaceId) : undefined;
      pointConnectors.push(
        connector({
          type: mapConnectorInterfaceName(interfaceName),
          powerKw: typeof raw.power === "number" ? raw.power : undefined,
          status,
        }),
      );
    }
    connectors.push(...pointConnectors);

    // EIPA prices per charge point, so a pool mixing an AC and a DC point
    // carries two tariffs — keep each one tied to its point's connectors.
    const tariff = mapEipaDynamicPrices(dyn?.prices);
    if (tariff) tariffCollector.add(pointConnectors, [tariff]);
  }

  const address: EvChargingAddress = {
    line1: joinAddress([cleanString(pool?.street), cleanString(pool?.house_number)]),
    town: cleanString(pool?.city) ?? cleanString(station.location?.city),
    state: cleanString(station.location?.province),
    postcode: cleanString(pool?.postal_code),
    country: "Poland",
  };

  const updatedAt = newestIsoString([
    cleanString(station.ts),
    cleanString(pool?.ts),
    ...points.map((p) => cleanString(p.ts)),
    ...dynamicEntries.map((d) => cleanString(d.status?.ts)),
  ]);

  return {
    poiId,
    lng,
    lat,
    payload: {
      // Coordinates duplicated in payload: the reader hands the mapper only
      // (poiId, payload) — geom is used for the SQL bbox filter, not returned.
      coordinates: [lng, lat] as [number, number],
      name: cleanString(pool?.name) ?? "EV Charging Station",
      address,
      operator: operatorName ? { name: operatorName } : undefined,
      status: stationStatus(dynamicEntries),
      connectors,
      tariffs: tariffCollector.build(connectors),
      updatedAt,
      sourceUrl: SOURCE_URL,
    },
  };
}

async function* iterate(seed: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  // station.json is the ingest seed; the other five files are secondary
  // joins fetched fresh each run (like OCPDB's tariffs/associations) so the
  // internal pool/operator/point/dynamic ids stay mutually consistent within
  // one run — we persist only resolved fields under the stable poiId, so id
  // churn between daily runs is harmless.
  const [dictionaryRaw, operatorsRaw, poolsRaw, pointsRaw, dynamicRaw] = await Promise.all([
    fetchEipaFile(PL_EIPA_DICTIONARY_URL, log),
    fetchEipaFile(PL_EIPA_OPERATOR_URL, log),
    fetchEipaFile(PL_EIPA_POOL_URL, log),
    fetchEipaFile(PL_EIPA_POINT_URL, log),
    fetchEipaFile(PL_EIPA_DYNAMIC_URL, log),
  ]);

  if (pointsRaw.length === 0) {
    log.error(
      "pl-eipa-parser: no points fetched this run — stations will have no connectors until next successful fetch",
    );
  }
  if (dynamicRaw.length === 0) {
    log.error(
      "pl-eipa-parser: no dynamic data fetched this run — stations will have no pricing/availability until next successful fetch",
    );
  }

  const connectorInterfaceNames = buildConnectorInterfaceNames(dictionaryRaw);
  const operatorsById = buildById<EipaOperator>(operatorsRaw);
  const poolsById = buildById<EipaPool>(poolsRaw);
  const pointsByStationId = buildPointsByStationId(pointsRaw);
  const dynamicByPointId = buildDynamicByPointId(dynamicRaw);

  const seen = new Set<string>();
  for (const raw of parseEipaEnvelope(seed)) {
    if (!raw || typeof raw !== "object") continue;
    const row = mapStationToRow(
      raw as EipaStation,
      poolsById,
      operatorsById,
      pointsByStationId,
      dynamicByPointId,
      connectorInterfaceNames,
    );
    if (!row) continue;
    if (seen.has(row.poiId)) {
      log.warn(`pl-eipa-parser: dropping duplicate station for poiId ${row.poiId}`);
      continue;
    }
    seen.add(row.poiId);
    yield row;
  }
}

export const parsePlEipa: PoiStaticParseFn = (buffer, { log }) => iterate(buffer, log);
