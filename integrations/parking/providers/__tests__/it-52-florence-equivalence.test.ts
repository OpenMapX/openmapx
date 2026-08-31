import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, vi } from "vitest";
import { mapIt52FlorencePayload, mergeIt52FlorenceLive } from "../it-52-florence-mapper.js";
import { parseIt52FlorenceBundled } from "../it-52-florence-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Pre-migration reference, lifted verbatim from the prior florence-it.ts.
 * Source id is `it-52-florence` (prefix `it-52-florence:`).
 */

interface RefRecord {
  Id: string;
  Name: string;
  FreeSpot: string;
  UpdateDate: string;
  Latitude: string;
  Longitude: string;
}

function refRecordToFacility(record: RefRecord): ParkingFacility | null {
  const lat = Number.parseFloat(record.Latitude);
  const lng = Number.parseFloat(record.Longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const freeSpaces = Number.parseInt(record.FreeSpot, 10);

  return {
    id: `it-52-florence:${record.Id}`,
    name: record.Name || "Parking",
    coordinates: [lng, lat],
    sources: ["it-52-florence"],
    parkingType: "garage",
    freeSpaces: !Number.isNaN(freeSpaces) && freeSpaces >= 0 ? freeSpaces : undefined,
    hasRealtimeData: true,
    fee: "paid",
    access: "public",
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "florence-it-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as RefRecord[];
  const out: ParkingFacility[] = [];
  for (const record of data) {
    const f = refRecordToFacility(record);
    if (f) out.push(f);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseIt52FlorenceBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapIt52FlorencePayload(row.poiId, row.payload);
    const merged = mergeIt52FlorenceLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

parkingEquivalenceContract({
  name: "Florence",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "freeSpaces",
    "hasRealtimeData",
    "fee",
    "access",
  ],
});
