import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapGhentPayload, mergeGhentLive } from "../ghent-be-mapper.js";
import { parseGhentBeBundled } from "../ghent-be-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior ghent-be.ts.
 * Source id is unchanged ("ghent-be", "ghent:" prefix).
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
    id: `ghent:${record.name}`,
    name: record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["ghent-be"],
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
  const { static: rows, live } = await parseGhentBeBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapGhentPayload(row.poiId, row.payload);
    const merged = mergeGhentLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

describe("ghent-be parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.operator, `row ${i}: operator`).toBe(r.operator);
      expect(g.openingHours, `row ${i}: openingHours`).toBe(r.openingHours);
      expect(g.state, `row ${i}: state`).toBe(r.state);
      expect(g.url, `row ${i}: url`).toBe(r.url);
    }
  });
});
