import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSingaporeLive } from "../singapore-live-parser.js";
import { mapSingaporePayload, mergeSingaporeLive } from "../singapore-mapper.js";
import { parseSingaporeStatic, svy21ToWgs84 } from "../singapore-static-parser.js";

beforeEach(() => {
  // Singapore's update_datetime values are emitted without a timezone, so
  // Date.parse interprets them as local time. Anchor system time to the
  // same local-time base so the staleness gate (30 min) doesn't trip
  // regardless of the host TZ.
  vi.useFakeTimers();
  const localFixtureBase = new Date("2026-05-23T09:59:30");
  vi.setSystemTime(new Date(localFixtureBase.getTime() + 5 * 60 * 1000));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Pre-migration reference: convert SVY21 to WGS84, type-map the carpark, then
 * apply per-carpark availability (summing C-lots only). Source id is
 * unchanged ("singapore", "sg:" prefix).
 */

interface StaticRecord {
  car_park_no: string;
  address: string;
  x_coord: string;
  y_coord: string;
  car_park_type: string;
  type_of_parking_system: string;
  short_term_parking: string;
  free_parking: string;
  night_parking: string;
  car_park_decks: number;
  gantry_height: number;
  car_park_basement: string;
}

interface LiveRecord {
  carpark_number: string;
  update_datetime: string;
  carpark_info: { total_lots: string; lot_type: string; lots_available: string }[];
}

const TYPE_MAP: Record<string, ParkingType> = {
  "MULTI-STOREY CAR PARK": "garage",
  "BASEMENT CAR PARK": "underground",
  "SURFACE CAR PARK": "surface",
  "COVERED CAR PARK": "garage",
  "MECHANISED CAR PARK": "garage",
};

function formatAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bBlk\b/g, "Blk")
    .replace(/\bHdb\b/g, "HDB")
    .replace(/\bMrt\b/g, "MRT")
    .replace(/\bAve\b/g, "Ave")
    .replace(/\bSt\b/g, "St")
    .replace(/\bDr\b/g, "Dr")
    .replace(/\bRd\b/g, "Rd")
    .replace(/\bCres\b/g, "Cres")
    .replace(/\bCl\b/g, "Cl");
}

const STATIC = readFileSync(join(__dirname, "fixtures", "singapore-static.json"));
const LIVE = readFileSync(join(__dirname, "fixtures", "singapore-live.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function refBuild(record: StaticRecord, avail: LiveRecord | undefined): ParkingFacility | null {
  const x = Number.parseFloat(record.x_coord);
  const y = Number.parseFloat(record.y_coord);
  if (Number.isNaN(x) || Number.isNaN(y) || x === 0 || y === 0) return null;
  const { lat, lng } = svy21ToWgs84(y, x);
  if (lat < 1.1 || lat > 1.5 || lng < 103.5 || lng > 104.1) return null;

  const gantryHeightM = record.gantry_height;
  const maxHeight =
    gantryHeightM != null && gantryHeightM > 0 ? Math.round(gantryHeightM * 100) : undefined;

  let capacity: number | undefined;
  let freeSpaces: number | undefined;
  if (avail) {
    let totalCar = 0;
    let freeCar = 0;
    for (const lot of avail.carpark_info) {
      if (lot.lot_type === "C") {
        totalCar += Number.parseInt(lot.total_lots, 10) || 0;
        freeCar += Number.parseInt(lot.lots_available, 10) || 0;
      }
    }
    if (totalCar > 0) {
      capacity = totalCar;
      freeSpaces = freeCar;
    }
  }

  return {
    id: `sg:${record.car_park_no}`,
    name: formatAddress(record.address),
    coordinates: [lng, lat],
    sources: ["singapore"],
    parkingType: TYPE_MAP[record.car_park_type] ?? "unknown",
    capacity,
    freeSpaces,
    hasRealtimeData: avail !== undefined,
    fee: record.free_parking !== "NO" ? "free" : "paid",
    address: record.address,
    maxHeight,
  };
}

function runReference(): ParkingFacility[] {
  const staticRecs = (
    JSON.parse(STATIC.toString("utf-8")) as { result: { records: StaticRecord[] } }
  ).result.records;
  const liveRecs = (
    JSON.parse(LIVE.toString("utf-8")) as { items: { carpark_data: LiveRecord[] }[] }
  ).items[0].carpark_data;
  const liveMap = new Map<string, LiveRecord>();
  for (const r of liveRecs) liveMap.set(r.carpark_number, r);

  const out: ParkingFacility[] = [];
  for (const r of staticRecs) {
    const built = refBuild(r, liveMap.get(r.car_park_no));
    if (built) out.push(built);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const rows = await parseSingaporeStatic(STATIC, { log: noopLog });
  const liveMap = await parseSingaporeLive(LIVE, { log: noopLog });
  const out: ParkingFacility[] = [];
  for (const row of rows as { poiId: string; lng: number; lat: number; payload: unknown }[]) {
    const base = mapSingaporePayload(row.poiId, row.payload);
    const merged = mergeSingaporeLive(base, liveMap.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    out.push(rest as ParkingFacility);
  }
  return out;
}

describe("singapore parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same facility ids in the same order", async () => {
    const ref = runReference();
    const got = await runMigrated();
    expect(got.map((f) => f.id)).toEqual(ref.map((f) => f.id));
  });

  it("produces field-by-field-identical facilities", async () => {
    const ref = runReference();
    const got = await runMigrated();
    expect(got).toHaveLength(ref.length);
    for (let i = 0; i < ref.length; i++) {
      const r = ref[i];
      const g = got[i];
      expect(g.id, `row ${i}: id`).toBe(r.id);
      expect(g.name, `row ${i}: name`).toBe(r.name);
      expect(g.coordinates[0], `row ${i}: lng`).toBeCloseTo(r.coordinates[0], 6);
      expect(g.coordinates[1], `row ${i}: lat`).toBeCloseTo(r.coordinates[1], 6);
      expect(g.sources, `row ${i}: sources`).toEqual(r.sources);
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.maxHeight, `row ${i}: maxHeight`).toBe(r.maxHeight);
    }
  });
});
