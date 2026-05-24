import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapBarcelonaPayload } from "../barcelona-es-mapper.js";
import { parseBarcelonaEsStatic } from "../barcelona-es-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior barcelona-es.ts.
 * Source id is unchanged ("barcelona-es", "barcelona:" prefix).
 */

interface RefGeometry {
  type: string;
  geometries?: Array<{ type: string; coordinates: [number, number] }>;
}

interface RefAddress {
  address_name?: string;
  start_street_number?: number | null;
  zip_code?: string;
  town?: string;
  location_4326?: RefGeometry;
}

interface RefRecord {
  register_id: number;
  name: string;
  status_name?: string;
  addresses?: RefAddress[];
  attribute_categories?: Array<{
    name: string;
    attributes: Array<{ name: string; values: Array<{ value: string }> }>;
  }>;
}

function refExtractCoords(address: RefAddress): [number, number] | null {
  const geom = address.location_4326;
  if (!geom?.geometries?.length) return null;
  const point = geom.geometries.find((g) => g.type === "Point");
  if (!point?.coordinates) return null;
  const [lat, lng] = point.coordinates;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return [lng, lat];
}

function refBuildAddress(addr: RefAddress): string | undefined {
  const parts: string[] = [];
  if (addr.address_name) {
    let street = addr.address_name;
    if (addr.start_street_number != null) street += ` ${addr.start_street_number}`;
    parts.push(street);
  }
  if (addr.zip_code && addr.town) parts.push(`${addr.zip_code} ${addr.town}`);
  else if (addr.town) parts.push(addr.town);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function refExtractPhone(record: RefRecord): string | undefined {
  if (!record.attribute_categories) return undefined;
  for (const cat of record.attribute_categories) {
    for (const attr of cat.attributes) {
      if (attr.name === "Tel." && attr.values?.length > 0) {
        return attr.values[0].value;
      }
    }
  }
  return undefined;
}

function refRecordToFacility(record: RefRecord): ParkingFacility | null {
  const address = record.addresses?.[0];
  if (!address) return null;
  const coords = refExtractCoords(address);
  if (!coords) return null;
  const phone = refExtractPhone(record);
  const streetAddress = refBuildAddress(address);
  const feeDescription = phone ? `Tel: ${phone}` : undefined;
  return {
    id: `barcelona:${record.register_id}`,
    name: record.name || "Parking",
    coordinates: coords,
    sources: ["barcelona-es"],
    parkingType: "garage",
    hasRealtimeData: false,
    fee: "paid",
    feeDescription,
    access: "public",
    address: streetAddress,
    state: record.status_name === "Publicat" ? "open" : "unknown",
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "barcelona-es-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as RefRecord[];
  const out: ParkingFacility[] = [];
  for (const record of data) {
    const f = refRecordToFacility(record);
    if (f) out.push(f);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseBarcelonaEsStatic(FIXTURE).map((row) => mapBarcelonaPayload(row.poiId, row.payload));
}

describe("barcelona-es parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.feeDescription, `row ${i}: feeDescription`).toBe(r.feeDescription);
      expect(g.access, `row ${i}: access`).toBe(r.access);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.state, `row ${i}: state`).toBe(r.state);
    }
  });
});
