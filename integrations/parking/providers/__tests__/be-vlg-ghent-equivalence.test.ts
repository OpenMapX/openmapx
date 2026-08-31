import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, vi } from "vitest";
import { mapBeVlgGhentPayload, mergeBeVlgGhentLive } from "../be-vlg-ghent-mapper.js";
import { parseBeVlgGhentBundled } from "../be-vlg-ghent-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Pre-migration reference, lifted verbatim from the prior ghent-be.ts.
 * Source id is `be-vlg-ghent` (prefix `be-vlg-ghent:`).
 */

interface RefRecord {
  name: string;
  lastupdate: string;
  totalcapacity: number;
  availablecapacity: number;
  type: string;
  description: string | null;
  id: string;
  openingtimesdescription: string | null;
  isopennow: number;
  temporaryclosed: number;
  operatorinformation: string | null;
  freeparking: number;
  urllinkaddress: string | null;
  location: { lon: number; lat: number } | null;
}

function refDeriveState(record: RefRecord): "open" | "closed" | "unknown" {
  if (record.temporaryclosed === 1) return "closed";
  if (record.isopennow === 1) return "open";
  return "unknown";
}

function refRecordToFacility(record: RefRecord): ParkingFacility | null {
  const lng = record.location?.lon;
  const lat = record.location?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity = record.totalcapacity > 0 ? record.totalcapacity : undefined;
  const freeSpaces =
    record.availablecapacity != null && record.availablecapacity >= 0
      ? record.availablecapacity
      : undefined;

  return {
    id: `be-vlg-ghent:${record.name}`,
    name: record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["be-vlg-ghent"],
    parkingType: "garage" as ParkingType,
    capacity,
    freeSpaces,
    hasRealtimeData: true,
    fee: record.freeparking === 1 ? "free" : "paid",
    operator: record.operatorinformation ?? undefined,
    openingHours: record.openingtimesdescription ?? undefined,
    state: refDeriveState(record),
    url: record.urllinkaddress ?? undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "ghent-be-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as { results: RefRecord[] };
  const out: ParkingFacility[] = [];
  for (const record of data.results) {
    const f = refRecordToFacility(record);
    if (f) out.push(f);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseBeVlgGhentBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapBeVlgGhentPayload(row.poiId, row.payload);
    const merged = mergeBeVlgGhentLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

parkingEquivalenceContract({
  name: "Ghent",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "capacity",
    "freeSpaces",
    "hasRealtimeData",
    "fee",
    "operator",
    "openingHours",
    "state",
    "url",
  ],
});
