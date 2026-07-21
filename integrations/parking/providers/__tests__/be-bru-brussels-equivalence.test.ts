import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapBeBruBrusselsPayload } from "../be-bru-brussels-mapper.js";
import { parseBeBruBrusselsStatic } from "../be-bru-brussels-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior brussels-be.ts.
 * Source id is `be-bru-brussels` (prefix `be-bru-brussels:`).
 */

interface BrusselsRecord {
  name_fr: string | null;
  name_nl: string | null;
  adressee: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  operator_fr: string | null;
  capacity: number | null;
  disabledcapacity: number | null;
  floors: number | null;
  maxheight: number | null;
}

interface BrusselsResponse {
  results: BrusselsRecord[];
}

function refParseMaxHeight(value: number | null): number | undefined {
  if (value == null || value <= 0) return undefined;
  return value < 10 ? Math.round(value * 100) : Math.round(value);
}

function refDeriveParkingType(record: BrusselsRecord): ParkingType {
  if (record.floors != null && record.floors > 1) return "garage";
  return "garage";
}

function refRecordToFacility(record: BrusselsRecord): ParkingFacility | null {
  const lng = record.geo_point_2d?.lon;
  const lat = record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const name = record.name_fr || record.name_nl || "Parking";
  const capacity = record.capacity != null && record.capacity > 0 ? record.capacity : undefined;
  const disabledSpaces =
    record.disabledcapacity != null && record.disabledcapacity > 0
      ? record.disabledcapacity
      : undefined;
  const maxHeight = refParseMaxHeight(record.maxheight);

  return {
    id: `be-bru-brussels:${name}`,
    name,
    coordinates: [lng, lat],
    sources: ["be-bru-brussels"],
    parkingType: refDeriveParkingType(record),
    capacity,
    hasRealtimeData: false,
    disabledSpaces,
    maxHeight,
    fee: "unknown",
    operator: record.operator_fr ?? undefined,
    address: record.adressee ?? undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "brussels-be-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as BrusselsResponse;
  const out: ParkingFacility[] = [];
  for (const record of data.results) {
    const facility = refRecordToFacility(record);
    if (facility) out.push(facility);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseBeBruBrusselsStatic(FIXTURE).map((row) =>
    mapBeBruBrusselsPayload(row.poiId, row.payload),
  );
}

describe("brussels-be parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same set of facility ids in the same order", () => {
    const reference = runReference();
    const migrated = runMigrated();
    expect(migrated.map((f) => f.id)).toEqual(reference.map((f) => f.id));
  });

  it("produces field-by-field-identical facilities", () => {
    const reference = runReference();
    const migrated = runMigrated();
    expect(migrated).toHaveLength(reference.length);
    for (let i = 0; i < reference.length; i++) {
      const ref = reference[i];
      const got = migrated[i];
      expect(got.id, `row ${i}: id`).toBe(ref.id);
      expect(got.name, `row ${i}: name`).toBe(ref.name);
      expect(got.coordinates, `row ${i}: coordinates`).toEqual(ref.coordinates);
      expect(got.sources, `row ${i}: sources`).toEqual(ref.sources);
      expect(got.parkingType, `row ${i}: parkingType`).toBe(ref.parkingType);
      expect(got.capacity, `row ${i}: capacity`).toBe(ref.capacity);
      expect(got.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(ref.hasRealtimeData);
      expect(got.disabledSpaces, `row ${i}: disabledSpaces`).toBe(ref.disabledSpaces);
      expect(got.maxHeight, `row ${i}: maxHeight`).toBe(ref.maxHeight);
      expect(got.fee, `row ${i}: fee`).toBe(ref.fee);
      expect(got.operator, `row ${i}: operator`).toBe(ref.operator);
      expect(got.address, `row ${i}: address`).toBe(ref.address);
    }
  });
});
