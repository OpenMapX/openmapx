import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapFlorencePayload, mergeFlorenceLive } from "../florence-it-mapper.js";
import { parseFlorenceItBundled } from "../florence-it-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior florence-it.ts.
 * Source id is unchanged ("florence-it", "florence:" prefix).
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
    id: `florence:${record.Id}`,
    name: record.Name || "Parking",
    coordinates: [lng, lat],
    sources: ["florence-it"],
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
  const { static: rows, live } = await parseFlorenceItBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapFlorencePayload(row.poiId, row.payload);
    const merged = mergeFlorenceLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

describe("florence-it parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same set of facility ids in the same order", async () => {
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
      expect(g.coordinates, `row ${i}: coordinates`).toEqual(r.coordinates);
      expect(g.sources, `row ${i}: sources`).toEqual(r.sources);
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.access, `row ${i}: access`).toBe(r.access);
    }
  });
});
