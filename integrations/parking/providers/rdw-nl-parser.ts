import type { ParkingType, RdwGeoRecord, RdwSpecsRecord } from "@openmapx/mobility-core/parking";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";

/**
 * RDW Netherlands Open Data parser (federated, static-only).
 *
 * The pre-migration provider queried four Socrata datasets per request and
 * joined them in-memory. The ingest pipeline needs ONE fetch — but the data
 * is naturally split across:
 *   - t5pc-eb34 (parking garages, ~237)
 *   - 6wzd-evwu (Park & Ride, ~134)
 *   - 9c54-cmfx (carpool lots, ~127)
 *   - b3us-f26s (per-area specifications, ~3,140)
 *
 * Same option-C approach as parkapi-v2's federated parser: the configured
 * fetch is a sentinel (the specs endpoint, also the largest), and this parser
 * fans the remaining three reads out via `globalThis.fetch` with bounded
 * concurrency, then joins them. All four endpoints are public/CC0 (no auth),
 * so the parser has no secret handling to worry about.
 *
 * Pre-migration id was `rdw:${areamanagerid}/${areaid}`.
 */

const SOCRATA_BASE = "https://opendata.rdw.nl/resource";
const GARAGE_RESOURCE = "t5pc-eb34";
const PNR_RESOURCE = "6wzd-evwu";
const CARPOOL_RESOURCE = "9c54-cmfx";

const GEO_LIMIT = 5000;
const FETCH_TIMEOUT_MS = 30_000;

const TYPE_MAP: Record<string, ParkingType> = {
  GARAGEP: "garage",
  PARKRIDE: "surface",
  CARPOOL: "surface",
};

function specsKey(areamanagerid: string, areaid: string): string {
  return `${areamanagerid}:${areaid}`;
}

function parsePositiveInt(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return !Number.isNaN(n) && n > 0 ? n : undefined;
}

function parseHeightCm(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return n < 10 ? Math.round(n * 100) : Math.round(n);
}

async function fetchGeoDataset(resourceId: string, log: PoiSourceLogger): Promise<RdwGeoRecord[]> {
  // No bbox filter at ingest time — pull the entire (small) dataset so the
  // pipeline can drive bbox queries from PostGIS later.
  const url = `${SOCRATA_BASE}/${resourceId}.json?$limit=${GEO_LIMIT}`;
  try {
    const res = await globalThis.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("rdw-nl: geo dataset fetch failed", {
        resource: resourceId,
        status: res.status,
      });
      return [];
    }
    return (await res.json()) as RdwGeoRecord[];
  } catch (err) {
    log.warn("rdw-nl: geo dataset fetch threw", {
      resource: resourceId,
      error: (err as Error).message,
    });
    return [];
  }
}

function parseSpecs(buffer: Buffer, log: PoiSourceLogger): Map<string, RdwSpecsRecord> {
  try {
    const records = JSON.parse(buffer.toString("utf-8")) as RdwSpecsRecord[];
    if (!Array.isArray(records)) return new Map();
    const map = new Map<string, RdwSpecsRecord>();
    for (const r of records) {
      if (!r?.areamanagerid || !r.areaid) continue;
      map.set(specsKey(r.areamanagerid, r.areaid), r);
    }
    return map;
  } catch (err) {
    log.warn("rdw-nl: failed to parse specs payload", { error: (err as Error).message });
    return new Map();
  }
}

function recordToRow(record: RdwGeoRecord, specs: RdwSpecsRecord | undefined): PoiRow | null {
  if (!record?.areamanagerid || !record.areaid) return null;
  const lat = Number.parseFloat(record.location?.latitude);
  const lng = Number.parseFloat(record.location?.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const usageid = record.usageid ?? "GARAGEP";
  const isPnR = usageid === "PARKRIDE";

  const capacity =
    parsePositiveInt(specs?.capacity) ?? parsePositiveInt(record.aantal_parkeer_plaatsen);
  const chargingSpaces =
    parsePositiveInt(specs?.chargingpointcapacity) ?? parsePositiveInt(record.aantal_laad_punten);
  const maxHeight =
    parseHeightCm(specs?.maximumvehicleheight) ?? parseHeightCm(record.maximale_inrij_hoogte);
  const hasDisabledAccess =
    specs?.disabledaccess === "True" || record.toegankelijk_voor_gehandicapten === "Ja";

  return {
    poiId: `${record.areamanagerid}/${record.areaid}`,
    lng,
    lat,
    payload: {
      coordinates: [lng, lat] as [number, number],
      name: record.areadesc || "Parking",
      parkingType: TYPE_MAP[usageid] ?? "unknown",
      capacity,
      disabledSpaces: hasDisabledAccess ? 1 : undefined,
      chargingSpaces,
      maxHeight,
      fee: "unknown",
      parkAndRide: isPnR || undefined,
    },
  };
}

async function* rdwNlAsyncIterable(buffer: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  // The configured fetch downloads the specs dataset (largest, also stable).
  const specsMap = parseSpecs(buffer, log);

  const [garages, pnr, carpool] = await Promise.all([
    fetchGeoDataset(GARAGE_RESOURCE, log),
    fetchGeoDataset(PNR_RESOURCE, log),
    fetchGeoDataset(CARPOOL_RESOURCE, log),
  ]);

  for (const r of [...garages, ...pnr, ...carpool]) {
    const spec = specsMap.get(specsKey(r.areamanagerid, r.areaid));
    const row = recordToRow(r, spec);
    if (row) yield row;
  }
}

export const parseRdwNlStatic: PoiStaticParseFn = (buffer, { log }) =>
  rdwNlAsyncIterable(buffer, log);
