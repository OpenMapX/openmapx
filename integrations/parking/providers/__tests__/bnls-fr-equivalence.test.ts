import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BnlsFrRecord, ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapBnlsPayload } from "../bnls-fr-mapper.js";
import { parseBnlsFrStatic } from "../bnls-fr-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior bnls-fr.ts.
 * Source id is unchanged ("bnls-fr", "bnls:" prefix).
 */

const TYPE_MAP: Record<string, ParkingType> = {
  ouvrage: "garage",
  enclos_en_surface: "surface",
};

function refTariffRows(record: BnlsFrRecord): [string, string][] | undefined {
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

function refRecordToFacility(
  record: BnlsFrRecord,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0] ?? record.xlong ?? record.geo_point_2d?.lon;
  const lat = geometry?.[1] ?? record.ylat ?? record.geo_point_2d?.lat;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const isFree = record.is_free === 1;
  const capacity =
    record.space_count != null && record.space_count > 0 ? record.space_count : undefined;

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
    tariffRows: isFree ? undefined : refTariffRows(record),
    access: record.user_type === "abonnes" ? "permit" : "public",
    address: record.address ?? undefined,
    parkAndRide: hasPnR || undefined,
    url: record.url ?? undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "bnls-fr-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as {
    features: Array<{ geometry: { coordinates: [number, number] }; properties: BnlsFrRecord }>;
  };
  const out: ParkingFacility[] = [];
  for (const feature of data.features) {
    const f = refRecordToFacility(feature.properties, feature.geometry?.coordinates);
    if (f) out.push(f);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseBnlsFrStatic(FIXTURE).map((row) => mapBnlsPayload(row.poiId, row.payload));
}

describe("bnls-fr parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same set of facility ids in the same order", () => {
    const ref = runReference();
    const got = runMigrated();
    expect(got.map((f) => f.id)).toEqual(ref.map((f) => f.id));
  });

  it("produces field-by-field-identical facilities", () => {
    const ref = runReference();
    const got = runMigrated();
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
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.disabledSpaces, `row ${i}: disabledSpaces`).toBe(r.disabledSpaces);
      expect(g.chargingSpaces, `row ${i}: chargingSpaces`).toBe(r.chargingSpaces);
      expect(g.maxHeight, `row ${i}: maxHeight`).toBe(r.maxHeight);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.feeDescription, `row ${i}: feeDescription`).toBe(r.feeDescription);
      expect(g.tariffRows, `row ${i}: tariffRows`).toEqual(r.tariffRows);
      expect(g.access, `row ${i}: access`).toBe(r.access);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.parkAndRide, `row ${i}: parkAndRide`).toBe(r.parkAndRide);
      expect(g.url, `row ${i}: url`).toBe(r.url);
    }
  });
});
