import type { BoundingBox } from "@openmapx/core";
import type {
  ParkingFacility,
  ParkingType,
  RdwGeoRecord,
  RdwSpecsRecord,
} from "@openmapx/mobility-core/parking";

/**
 * Netherlands RDW Open Data parking client.
 *
 * Uses three Socrata GEO datasets with `within_box` bbox support:
 *   - t5pc-eb34: Parking garages (~237)
 *   - 6wzd-evwu: Park & Ride (~134)
 *   - 9c54-cmfx: Carpool lots (~127)
 * Enriched with capacity/specs from b3us-f26s (~3140 records).
 *
 * License: CC0 (public domain). No authentication required.
 */

const SOCRATA_BASE = "https://opendata.rdw.nl/resource";
const GARAGE_RESOURCE = "t5pc-eb34";
const PNR_RESOURCE = "6wzd-evwu";
const CARPOOL_RESOURCE = "9c54-cmfx";
const SPECS_RESOURCE = "b3us-f26s";

const SPECS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data, rarely changes

const COVERAGE_BBOX = { south: 50.7, west: 3.3, north: 53.7, east: 7.3 };

let specsCache: { specs: Map<string, RdwSpecsRecord>; fetchedAt: number } | null = null;

const TYPE_MAP: Record<string, ParkingType> = {
  GARAGEP: "garage",
  PARKRIDE: "surface",
  CARPOOL: "surface",
};

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function specsKey(areamanagerid: string, areaid: string): string {
  return `${areamanagerid}:${areaid}`;
}

async function fetchSpecs(): Promise<Map<string, RdwSpecsRecord>> {
  if (specsCache && Date.now() - specsCache.fetchedAt < SPECS_CACHE_TTL) {
    return specsCache.specs;
  }

  const url = `${SOCRATA_BASE}/${SPECS_RESOURCE}.json?$limit=5000`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (specsCache) return specsCache.specs;
    return new Map();
  }

  const records = (await res.json()) as RdwSpecsRecord[];
  const map = new Map<string, RdwSpecsRecord>();
  for (const r of records) {
    map.set(specsKey(r.areamanagerid, r.areaid), r);
  }

  specsCache = { specs: map, fetchedAt: Date.now() };
  return map;
}

async function fetchGeoDataset(resourceId: string, bbox: BoundingBox): Promise<RdwGeoRecord[]> {
  const where = `within_box(location,${bbox.north},${bbox.west},${bbox.south},${bbox.east})`;
  const url = `${SOCRATA_BASE}/${resourceId}.json?$where=${encodeURIComponent(where)}&$limit=1000`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  return (await res.json()) as RdwGeoRecord[];
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
  // Values < 10 are meters, >= 10 are already centimeters
  return n < 10 ? Math.round(n * 100) : Math.round(n);
}

function recordToFacility(record: RdwGeoRecord, specs?: RdwSpecsRecord): ParkingFacility | null {
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
    id: `rdw:${record.areamanagerid}/${record.areaid}`,
    name: record.areadesc || "Parking",
    coordinates: [lng, lat],
    sources: ["rdw-nl"],
    parkingType: TYPE_MAP[usageid] ?? "unknown",
    capacity,
    hasRealtimeData: false,
    disabledSpaces: hasDisabledAccess ? 1 : undefined,
    chargingSpaces,
    maxHeight,
    fee: "unknown",
    parkAndRide: isPnR || undefined,
  };
}

export async function searchRdwNl(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const [garages, pnr, carpool, specs] = await Promise.allSettled([
    fetchGeoDataset(GARAGE_RESOURCE, bbox),
    fetchGeoDataset(PNR_RESOURCE, bbox),
    fetchGeoDataset(CARPOOL_RESOURCE, bbox),
    fetchSpecs(),
  ]);

  const allRecords = [
    ...(garages.status === "fulfilled" ? garages.value : []),
    ...(pnr.status === "fulfilled" ? pnr.value : []),
    ...(carpool.status === "fulfilled" ? carpool.value : []),
  ];

  const specsMap = specs.status === "fulfilled" ? specs.value : new Map<string, RdwSpecsRecord>();

  const facilities: ParkingFacility[] = [];
  for (const record of allRecords) {
    const spec = specsMap.get(specsKey(record.areamanagerid, record.areaid));
    const facility = recordToFacility(record, spec);
    if (facility) facilities.push(facility);
  }

  return facilities;
}

export async function fetchRdwNlDetail(
  areamanagerid: string,
  areaid: string,
): Promise<ParkingFacility | null> {
  // Validate input to prevent SoQL injection
  if (!/^[\w-]+$/.test(areamanagerid) || !/^[\w.-]+$/.test(areaid)) return null;

  const where = encodeURIComponent(`areamanagerid='${areamanagerid}' AND areaid='${areaid}'`);

  const fetches = [GARAGE_RESOURCE, PNR_RESOURCE, CARPOOL_RESOURCE].map((resource) =>
    fetch(`${SOCRATA_BASE}/${resource}.json?$where=${where}&$limit=1`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).then((r) => (r.ok ? (r.json() as Promise<RdwGeoRecord[]>) : [])),
  );

  const [garageRes, pnrRes, carpoolRes, specs] = await Promise.allSettled([
    ...fetches,
    fetchSpecs(),
  ]);

  const records = [
    ...(garageRes.status === "fulfilled" ? (garageRes.value as RdwGeoRecord[]) : []),
    ...(pnrRes.status === "fulfilled" ? (pnrRes.value as RdwGeoRecord[]) : []),
    ...(carpoolRes.status === "fulfilled" ? (carpoolRes.value as RdwGeoRecord[]) : []),
  ];

  if (records.length === 0) return null;

  const specsMap =
    specs.status === "fulfilled"
      ? (specs.value as Map<string, RdwSpecsRecord>)
      : new Map<string, RdwSpecsRecord>();
  const spec = specsMap.get(specsKey(areamanagerid, areaid));

  return recordToFacility(records[0], spec);
}
