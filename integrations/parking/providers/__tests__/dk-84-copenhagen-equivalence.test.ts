import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapDk84CopenhagenPayload } from "../dk-84-copenhagen-mapper.js";
import { parseDk84CopenhagenStatic } from "../dk-84-copenhagen-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior copenhagen-dk.ts.
 * Source id is `dk-84-copenhagen` (prefix `dk-84-copenhagen:`).
 */

interface RefProps {
  id: number;
  vejnavn: string | null;
  husnr: string | null;
  postdistrikt: string | null;
  antal_pladser: number | null;
  ejer_status: string | null;
  type_beskrivelse: string | null;
  bemaerkning: string | null;
}

interface RefResponse {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: RefProps;
  }>;
}

function refMapParkingType(typeBeskrivelse: string | null): ParkingType {
  if (!typeBeskrivelse) return "garage";
  const lower = typeBeskrivelse.toLowerCase();
  if (lower.includes("kælder") || lower.includes("kaelder")) return "underground";
  return "garage";
}

function refFeatureToFacility(
  props: RefProps,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0];
  const lat = geometry?.[1];
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity =
    props.antal_pladser != null && props.antal_pladser > 0 ? props.antal_pladser : undefined;

  let name = "Parking";
  if (props.bemaerkning) {
    name = props.bemaerkning;
  } else if (props.vejnavn) {
    name = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
  }

  let address: string | undefined;
  if (props.vejnavn) {
    const street = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
    address = props.postdistrikt ? `${street}, ${props.postdistrikt}` : street;
  }

  const access = props.ejer_status === "Privat" ? ("private" as const) : ("public" as const);

  return {
    id: `dk-84-copenhagen:${props.id}`,
    name,
    coordinates: [lng, lat],
    sources: ["dk-84-copenhagen"],
    parkingType: refMapParkingType(props.type_beskrivelse),
    capacity,
    hasRealtimeData: false,
    fee: "unknown",
    access,
    address,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "copenhagen-dk-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as RefResponse;
  const out: ParkingFacility[] = [];
  for (const feature of data.features) {
    const f = refFeatureToFacility(feature.properties, feature.geometry?.coordinates);
    if (f) out.push(f);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseDk84CopenhagenStatic(FIXTURE).map((row) =>
    mapDk84CopenhagenPayload(row.poiId, row.payload),
  );
}

describe("copenhagen-dk parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.access, `row ${i}: access`).toBe(r.access);
      expect(g.address, `row ${i}: address`).toBe(r.address);
    }
  });
});
