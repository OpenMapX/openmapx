import { gunzipSync } from "node:zlib";
import type { EvChargingConnector, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { attachTariffs, buildTariffMap, NL_DOTNL_TARIFFS_URL } from "./nl-dotnl-tariff.js";
import { cleanString, connector, nlDotnlLocationPoiId } from "./utils.js";

// NDW/DOT-NL national open charging data (National Access Point) — OCPI 2.2
// Locations array. Served as a bare gzip body (no Content-Encoding header —
// see the scout report), so callers must gunzip before parsing; the buffer
// this parser receives is assumed already-decompressed JSON, mirroring how
// ch-sfoe-parser.ts treats its buffer.
export const NL_DOTNL_LOCATIONS_URL =
  "https://opendata.ndw.nu/charging_point_locations_ocpi.json.gz";

const TARIFFS_FETCH_TIMEOUT_MS = 30_000;

/**
 * Ceiling for an inflated tariffs feed. The normal feed is far smaller than
 * this, while the limit prevents a hostile gzip response from exhausting the
 * process before its JSON can be parsed.
 */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

function gunzipBounded(buffer: Buffer): Buffer {
  try {
    return gunzipSync(buffer, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`Inflated feed exceeds max ${MAX_INFLATED_BYTES} bytes`);
    }
    throw err;
  }
}

interface OcpiCoordinates {
  latitude?: string;
  longitude?: string;
}

interface OcpiOperator {
  name?: string;
}

interface OcpiConnector {
  id?: string;
  standard?: string;
  power_type?: string;
  tariff_ids?: Array<string | null> | null;
  max_electric_power?: number;
}

interface OcpiEvse {
  status?: string;
  connectors?: OcpiConnector[];
}

interface OcpiLocation {
  id?: string;
  name?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  country_code?: string;
  party_id?: string;
  operator?: OcpiOperator | null;
  coordinates?: OcpiCoordinates;
  evses?: OcpiEvse[];
  last_updated?: string;
}

function mapConnectorStandard(standard: string | undefined): string {
  switch (standard) {
    case "IEC_62196_T2":
      return "Type 2";
    case "IEC_62196_T2_COMBO":
      return "CCS (Type 2)";
    case "CHADEMO":
      return "CHAdeMO";
    case "DOMESTIC_E":
      return "Type E (domestic)";
    default:
      return standard ?? "Unknown";
  }
}

function mapCurrentType(powerType: string | undefined): "AC" | "DC" | undefined {
  if (!powerType) return undefined;
  if (powerType.startsWith("AC")) return "AC";
  if (powerType === "DC") return "DC";
  return undefined;
}

function roundKw(watts: number | undefined): number | undefined {
  if (typeof watts !== "number" || !Number.isFinite(watts)) return undefined;
  return Math.round((watts / 1000) * 10) / 10;
}

function mapLocationToRow(raw: unknown, tariffMap: Map<string, EvChargingTariff[]>): PoiRow | null {
  if (!raw || typeof raw !== "object") return null;
  const location = raw as OcpiLocation;

  const poiId = nlDotnlLocationPoiId(location);
  if (!poiId) return null;

  const lat = Number(location.coordinates?.latitude);
  const lng = Number(location.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const tariffIds = new Set<string>();
  const connectors: EvChargingConnector[] = [];
  for (const evse of location.evses ?? []) {
    for (const conn of evse.connectors ?? []) {
      for (const tariffId of conn.tariff_ids ?? []) {
        const cleaned = cleanString(tariffId ?? undefined);
        if (cleaned) tariffIds.add(cleaned);
      }
      connectors.push(
        connector({
          type: mapConnectorStandard(conn.standard),
          powerKw: roundKw(conn.max_electric_power),
          currentType: mapCurrentType(conn.power_type),
          reference: cleanString(conn.id),
        }),
      );
    }
  }

  const operatorName = cleanString(location.operator?.name);

  return {
    poiId,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat],
      name: cleanString(location.name) ?? "EV Charging Station",
      address: {
        line1: cleanString(location.address),
        town: cleanString(location.city),
        postcode: cleanString(location.postal_code),
        country: cleanString(location.country_code),
      },
      operator: operatorName ? { name: operatorName } : undefined,
      connectors,
      tariffs: attachTariffs(Array.from(tariffIds), tariffMap),
      updatedAt: cleanString(location.last_updated),
    },
  };
}

async function fetchTariffMap(log: PoiSourceLogger): Promise<Map<string, EvChargingTariff[]>> {
  try {
    const res = await globalThis.fetch(NL_DOTNL_TARIFFS_URL, {
      signal: AbortSignal.timeout(TARIFFS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error(
        `nl-dotnl-parser: DOT-NL tariffs unavailable this run — stations will have no pricing until next successful fetch: HTTP ${res.status}`,
      );
      return new Map();
    }
    const compressed = Buffer.from(await res.arrayBuffer());
    // The tariffs feed is a bare gzip body — no Content-Encoding header, so
    // fetch()/undici won't auto-decompress it (see the scout report).
    const decompressed = gunzipBounded(compressed);
    const parsed = JSON.parse(decompressed.toString("utf-8")) as unknown;
    return buildTariffMap(parsed);
  } catch (err) {
    log.error(
      `nl-dotnl-parser: DOT-NL tariffs unavailable this run — stations will have no pricing until next successful fetch: ${(err as Error).message}`,
    );
    return new Map();
  }
}

async function* nlDotnlAsyncIterable(buffer: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  const locations = JSON.parse(buffer.toString("utf-8")) as unknown;
  if (!Array.isArray(locations)) return;

  const tariffMap = await fetchTariffMap(log);

  // Composite country+party+id keys are unique per the OCPI spec, but the
  // feed is aggregated from many CPOs and has already shown real-world
  // quirks (see the scout report) — dedupe defensively so a collision never
  // reaches the Postgres upsert and aborts the whole batch with a duplicate
  // PK error. Keeps the FIRST occurrence per poiId, drops the rest.
  const seenPoiIds = new Set<string>();
  for (const raw of locations) {
    const row = mapLocationToRow(raw, tariffMap);
    if (!row) continue;
    if (seenPoiIds.has(row.poiId)) {
      log.warn(`nl-dotnl-parser: dropping duplicate location for poiId ${row.poiId}`);
      continue;
    }
    seenPoiIds.add(row.poiId);
    yield row;
  }
}

export const parseNlDotnl: PoiStaticParseFn = (buffer, { log }) =>
  nlDotnlAsyncIterable(buffer, log);
