import type { BoundingBox } from "@openmapx/core";
import type { BnlsFrRecord, ParkingFacility, ParkingType } from "./types.js";

/**
 * France BNLS (Base Nationale des Lieux de Stationnement) parking client.
 *
 * Uses the Opendatasoft mirror which is actively maintained (updated 2026-04-10).
 * ~826 static records covering structured parking across France.
 * No real-time availability data.
 *
 * License: ODbL. No authentication required. 10M requests/day.
 */

const API_BASE =
  "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/mobilityref-france-base-nationale-des-lieux-de-stationnement";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 41.3, west: -5.2, north: 51.1, east: 9.6 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

const TYPE_MAP: Record<string, ParkingType> = {
  ouvrage: "garage",
  enclos_en_surface: "surface",
};

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function buildTariffRows(record: BnlsFrRecord): [string, string][] | undefined {
  const rows: [string, string][] = [];
  if (record.cost_1h != null) rows.push(["1h", `€${record.cost_1h.toFixed(2)}`]);
  if (record.cost_2h != null) rows.push(["2h", `€${record.cost_2h.toFixed(2)}`]);
  if (record.cost_3h != null) rows.push(["3h", `€${record.cost_3h.toFixed(2)}`]);
  if (record.cost_4h != null) rows.push(["4h", `€${record.cost_4h.toFixed(2)}`]);
  if (record.cost_24h != null) rows.push(["24h", `€${record.cost_24h.toFixed(2)}`]);
  if (record.resident_sub != null) {
    rows.push(["Monthly (resident)", `€${record.resident_sub.toFixed(2)}`]);
  }
  if (record.non_resident_sub != null) {
    rows.push(["Monthly", `€${record.non_resident_sub.toFixed(2)}`]);
  }
  return rows.length > 0 ? rows : undefined;
}

function recordToFacility(
  record: BnlsFrRecord,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0] ?? record.xlong ?? record.geo_point_2d?.lon;
  const lat = geometry?.[1] ?? record.ylat ?? record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const isFree = record.is_free === 1;
  const capacity =
    record.space_count != null && record.space_count > 0 ? record.space_count : undefined;

  // Max height: assume cm if >= 10, meters if < 10
  let maxHeight: number | undefined;
  if (record.max_height != null && record.max_height > 0) {
    maxHeight =
      record.max_height < 10 ? Math.round(record.max_height * 100) : Math.round(record.max_height);
  }

  const disabledSpaces =
    record.disable_count != null && record.disable_count > 0 ? record.disable_count : undefined;
  const chargingSpaces =
    record.electric_car_count != null && record.electric_car_count > 0
      ? record.electric_car_count
      : undefined;
  const hasPnR = record.park_ride_count != null && record.park_ride_count > 0;

  return {
    id: `bnls:${record.id}`,
    name: record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["bnls-fr"],
    parkingType: TYPE_MAP[record.facilities_type ?? ""] ?? "unknown",
    capacity,
    hasRealtimeData: false,
    disabledSpaces,
    chargingSpaces,
    maxHeight,
    fee: isFree ? "free" : capacity ? "paid" : "unknown",
    feeDescription: record.info ?? undefined,
    tariffRows: isFree ? undefined : buildTariffRows(record),
    access: record.user_type === "abonnes" ? "permit" : "public",
    address: record.address ?? undefined,
    parkAndRide: hasPnR || undefined,
    url: record.url ?? undefined,
  };
}

interface BnlsGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: BnlsFrRecord;
  }>;
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const url = `${API_BASE}/exports/geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`BNLS France failed: ${res.status}`);
  }

  const data = (await res.json()) as BnlsGeoJsonResponse;

  const facilities: ParkingFacility[] = [];
  for (const feature of data.features) {
    const coords = feature.geometry?.coordinates as [number, number] | undefined;
    const facility = recordToFacility(feature.properties, coords);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchBnlsFr(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchBnlsFrDetail(bnlsId: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `bnls:${bnlsId}`) ?? null;
}
