/**
 * NDW Netherlands truck parking client.
 *
 * Uses the NDW open data Datex II feeds for real-time truck parking occupancy.
 * Two feeds: static table (v2) with facility info, dynamic status (v3) with
 * real-time vacant/occupied spaces. ~7 truck parking locations.
 *
 * License: CC0 1.0 (Public Domain). No authentication required.
 */

import type { BoundingBox } from "@openmapx/core";
import type { DatexParkingRecord, DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";
import type { ParkingFacility } from "./types.js";

const TABLE_URL = "https://opendata.ndw.nu/Truckparking_Parking_Table.xml";
const STATUS_URL = "https://opendata.ndw.nu/Truckparking_Parking_Status.xml";

const TABLE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data
const STATUS_CACHE_TTL = 2 * 60 * 1000; // 2 min — real-time

const COVERAGE_BBOX = { south: 50.7, west: 3.3, north: 53.6, east: 7.3 };

let tableCache: { records: DatexParkingRecord[]; fetchedAt: number } | null = null;
let statusCache: { statuses: DatexParkingStatus[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

async function fetchTable(): Promise<DatexParkingRecord[]> {
  if (tableCache && Date.now() - tableCache.fetchedAt < TABLE_CACHE_TTL) {
    return tableCache.records;
  }

  const res = await fetch(TABLE_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: { "Accept-Encoding": "gzip" },
  });

  if (!res.ok) {
    if (tableCache) return tableCache.records;
    throw new Error(`NDW parking table failed: ${res.status}`);
  }

  const xml = await res.text();
  const records = parseDatexParkingTable(xml);
  tableCache = { records, fetchedAt: Date.now() };
  return records;
}

async function fetchStatus(): Promise<DatexParkingStatus[]> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL) {
    return statusCache.statuses;
  }

  const res = await fetch(STATUS_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { "Accept-Encoding": "gzip" },
  });

  if (!res.ok) {
    if (statusCache) return statusCache.statuses;
    throw new Error(`NDW parking status failed: ${res.status}`);
  }

  const xml = await res.text();
  const statuses = parseDatexParkingStatus(xml);
  statusCache = { statuses, fetchedAt: Date.now() };
  return statuses;
}

function buildFacilities(
  records: DatexParkingRecord[],
  statuses: DatexParkingStatus[],
): ParkingFacility[] {
  const statusMap = new Map<string, DatexParkingStatus>();
  for (const s of statuses) statusMap.set(s.recordId, s);

  return records.map((rec) => {
    const status = statusMap.get(rec.id);
    const hasRealtime = status !== undefined;

    let freeSpaces: number | undefined;
    let state: "open" | "closed" | "unknown" = "unknown";

    if (status) {
      freeSpaces = status.vacantSpaces;
      if (status.siteStatus === "closed") state = "closed";
      else if (status.siteStatus) state = "open";
    }

    const hasCharging = rec.equipmentTypes?.includes("electricChargingStation") ?? false;

    return {
      id: `ndw-truck:${rec.id}`,
      name: rec.name,
      coordinates: [rec.longitude, rec.latitude] as [number, number],
      sources: ["ndw-truck-nl"],
      parkingType: "surface" as const,
      capacity: rec.totalSpaces,
      freeSpaces,
      hasRealtimeData: hasRealtime,
      fee:
        rec.freeOfCharge === true
          ? ("free" as const)
          : rec.freeOfCharge === false
            ? ("paid" as const)
            : ("unknown" as const),
      state,
      chargingSpaces: hasCharging ? 1 : undefined,
      chargingDetails: hasCharging ? "EV Charging Available" : undefined,
    };
  });
}

export async function searchNdwTruckNl(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const [records, statuses] = await Promise.all([fetchTable(), fetchStatus()]);
  const facilities = buildFacilities(records, statuses);

  return facilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchNdwTruckNlDetail(id: string): Promise<ParkingFacility | null> {
  const [records, statuses] = await Promise.all([fetchTable(), fetchStatus()]);
  const facilities = buildFacilities(records, statuses);
  return facilities.find((f) => f.id === `ndw-truck:${id}`) ?? null;
}
