import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapBaselPayload, mergeBaselLive } from "../basel-ch-mapper.js";
import { parseBaselChBundled } from "../basel-ch-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior basel-ch.ts.
 * Source id is unchanged ("basel-ch", "basel:" prefix).
 */

interface BaselRecord {
  published: string;
  free: number;
  total: number;
  auslastungen: number | null;
  id: string;
  id2: string;
  title: string;
  name: string;
  address: string | null;
  link: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  description: string | null;
}

interface BaselResponse {
  total_count: number;
  results: BaselRecord[];
}

function refRecordToFacility(record: BaselRecord): ParkingFacility | null {
  const lng = record.geo_point_2d?.lon;
  const lat = record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity = record.total > 0 ? record.total : undefined;
  const freeSpaces = record.free != null && record.free >= 0 ? record.free : undefined;

  return {
    id: `basel:${record.id2}`,
    name: record.title || record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["basel-ch"],
    parkingType: "garage" as ParkingType,
    capacity,
    freeSpaces,
    hasRealtimeData: true,
    fee: "paid",
    address: record.address ?? undefined,
    url: record.link ?? undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "basel-ch-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as BaselResponse;
  const out: ParkingFacility[] = [];
  for (const record of data.results) {
    const f = refRecordToFacility(record);
    if (f) out.push(f);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseBaselChBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapBaselPayload(row.poiId, row.payload);
    const merged = mergeBaselLive(base, live.get(row.poiId) ?? null);
    // Pre-migration impl never wrote dataUpdatedAt / realtimeDataUpdatedAt —
    // strip before equivalence so it stays focused on shared fields.
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

describe("basel-ch parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.url, `row ${i}: url`).toBe(r.url);
    }
  });
});
