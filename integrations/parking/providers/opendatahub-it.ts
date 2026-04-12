/**
 * Open Data Hub South Tyrol parking client.
 *
 * Uses the Open Data Hub REST API for ~63 parking stations in South Tyrol
 * (Alto Adige, Italy). Combines station metadata with latest occupancy
 * measurements where available and fresh enough (< 1 hour old).
 *
 * License: CC0 1.0. No authentication required.
 * Rate limit: 10 req/window (anonymous tier).
 */

import type { BoundingBox } from "@openmapx/core";
import type {
  OdhParkingMeasurement,
  OdhParkingStation,
  ParkingFacility,
  ParkingType,
} from "./types.js";

const BASE_URL = "https://mobility.api.opendatahub.com/v2/flat/ParkingStation";
const STATIONS_TTL = 60 * 60 * 1000; // 1h — metadata changes rarely
const MEASUREMENTS_TTL = 5 * 60 * 1000; // 5 min — real-time data
const MEASUREMENT_MAX_AGE = 60 * 60 * 1000; // 1h — discard stale measurements

const COVERAGE_BBOX = { south: 46.2, west: 10.3, north: 47.1, east: 12.5 };

let stationsCache: { stations: OdhParkingStation[]; fetchedAt: number } | null = null;
let measurementsCache: { measurements: OdhParkingMeasurement[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function deriveLayout(station: OdhParkingStation): ParkingType {
  const layout = station.smetadata?.netex_parking?.layout;
  if (layout === "underground") return "underground";
  if (layout === "openSpace") return "surface";
  if (layout === "multiStorey" || layout === "multistorey") return "garage";
  return "unknown";
}

function getStationName(station: OdhParkingStation): string {
  const meta = station.smetadata as Record<string, unknown>;
  return (
    (meta?.name_en as string) ??
    (meta?.name_EN as string) ??
    (meta?.name_de as string) ??
    (meta?.name_DE as string) ??
    (meta?.name_it as string) ??
    (meta?.name_IT as string) ??
    (meta?.standard_name as string) ??
    station.sname
  );
}

async function fetchStations(): Promise<OdhParkingStation[]> {
  if (stationsCache && Date.now() - stationsCache.fetchedAt < STATIONS_TTL) {
    return stationsCache.stations;
  }

  const url = `${BASE_URL}?select=scode,sname,scoordinate,smetadata&where=sactive.eq.true&limit=200&shownull=false&distinct=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    if (stationsCache) return stationsCache.stations;
    throw new Error(`ODH stations failed: ${res.status}`);
  }

  const data = (await res.json()) as { data: OdhParkingStation[] };
  const stations = data.data ?? [];
  stationsCache = { stations, fetchedAt: Date.now() };
  return stations;
}

async function fetchMeasurements(): Promise<OdhParkingMeasurement[]> {
  if (measurementsCache && Date.now() - measurementsCache.fetchedAt < MEASUREMENTS_TTL) {
    return measurementsCache.measurements;
  }

  const url = `${BASE_URL}/*/latest?select=scode,tname,mvalue,mvalidtime&where=sactive.eq.true&limit=500&shownull=false&distinct=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    if (measurementsCache) return measurementsCache.measurements;
    throw new Error(`ODH measurements failed: ${res.status}`);
  }

  const data = (await res.json()) as { data: OdhParkingMeasurement[] };
  const measurements = data.data ?? [];
  measurementsCache = { measurements, fetchedAt: Date.now() };
  return measurements;
}

function buildFacilities(
  stations: OdhParkingStation[],
  measurements: OdhParkingMeasurement[],
): ParkingFacility[] {
  // Build measurement map: scode → { occupied?, free? }
  const measMap = new Map<string, { occupied?: number; free?: number }>();
  for (const m of measurements) {
    if (m.tname !== "occupied" && m.tname !== "free") continue;

    const validTime = new Date(m.mvalidtime);
    if (Date.now() - validTime.getTime() > MEASUREMENT_MAX_AGE) continue;

    const existing = measMap.get(m.scode) ?? {};
    if (m.tname === "occupied") existing.occupied = m.mvalue;
    if (m.tname === "free") existing.free = m.mvalue;
    measMap.set(m.scode, existing);
  }

  return stations
    .map((station): ParkingFacility | null => {
      const lng = station.scoordinate?.x;
      const lat = station.scoordinate?.y;
      if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) return null;

      const capacity = station.smetadata?.capacity;
      const meas = measMap.get(station.scode);
      const hasRealtime =
        meas !== undefined && (meas.free !== undefined || meas.occupied !== undefined);

      let freeSpaces: number | undefined;
      if (meas?.free !== undefined) {
        freeSpaces = meas.free;
      } else if (meas?.occupied !== undefined && capacity) {
        freeSpaces = Math.max(0, capacity - meas.occupied);
      }

      const hasCharging = station.smetadata?.netex_parking?.charging === true;
      const municipality = station.smetadata?.municipality;

      return {
        id: `odh:${station.scode}`,
        name: getStationName(station),
        coordinates: [lng, lat] as [number, number],
        sources: ["opendatahub-it"],
        parkingType: deriveLayout(station),
        capacity,
        freeSpaces,
        hasRealtimeData: hasRealtime,
        fee: "unknown" as const,
        address: municipality ? `${municipality}, South Tyrol` : "South Tyrol, Italy",
        chargingSpaces: hasCharging ? 1 : undefined,
        chargingDetails: hasCharging ? "EV Charging Available" : undefined,
      };
    })
    .filter((f): f is ParkingFacility => f !== null);
}

export async function searchOdhIt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const [stations, measurements] = await Promise.all([fetchStations(), fetchMeasurements()]);
  const facilities = buildFacilities(stations, measurements);

  return facilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchOdhItDetail(id: string): Promise<ParkingFacility | null> {
  const [stations, measurements] = await Promise.all([fetchStations(), fetchMeasurements()]);
  const facilities = buildFacilities(stations, measurements);
  return facilities.find((f) => f.id === `odh:${id}`) ?? null;
}
