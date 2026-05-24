import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapViennaPayload } from "../vienna-at-mapper.js";
import { parseViennaAtStatic } from "../vienna-at-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior vienna-at.ts.
 * Source id is unchanged ("vienna-at", "vienna:" prefix).
 */

interface RefProps {
  OBJECTID: number;
  GARAGE_ID: string;
  BETREIBER: string | null;
  BEZEICHNUNG: string | null;
  PLZ: number | null;
  ORT: string | null;
  ADRESSE: string | null;
  WEBLINK_BETR_DE: string | null;
  WEBLINK_WK_DE: string | null;
  LONGITUDE: number | null;
  LATITUDE: number | null;
  PARK_AND_RIDE: string | null;
  BEHINDERTENPARKPL: string | null;
}

function refFeatureToFacility(
  props: RefProps,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0] ?? props.LONGITUDE;
  const lat = geometry?.[1] ?? props.LATITUDE;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const isPnR = props.PARK_AND_RIDE === "Y";
  const hasDisabled = props.BEHINDERTENPARKPL === "Y";

  let address: string | undefined;
  if (props.ADRESSE) {
    address =
      props.ORT && props.PLZ ? `${props.ADRESSE}, ${props.PLZ} ${props.ORT}` : props.ADRESSE;
  }

  const parkingType: ParkingType = "garage";

  return {
    id: `vienna:${props.GARAGE_ID}`,
    name: props.BEZEICHNUNG || "Parking",
    coordinates: [lng, lat],
    sources: ["vienna-at"],
    parkingType,
    hasRealtimeData: false,
    disabledSpaces: hasDisabled ? 1 : undefined,
    fee: "unknown",
    access: "public",
    operator: props.BETREIBER ?? undefined,
    address,
    parkAndRide: isPnR || undefined,
    url: props.WEBLINK_BETR_DE ?? props.WEBLINK_WK_DE ?? undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "vienna-at-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as {
    features: Array<{ geometry: { coordinates: [number, number] }; properties: RefProps }>;
  };
  const out: ParkingFacility[] = [];
  for (const feature of data.features) {
    const f = refFeatureToFacility(feature.properties, feature.geometry?.coordinates);
    if (f) out.push(f);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseViennaAtStatic(FIXTURE).map((row) => mapViennaPayload(row.poiId, row.payload));
}

describe("vienna-at parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.disabledSpaces, `row ${i}: disabledSpaces`).toBe(r.disabledSpaces);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.access, `row ${i}: access`).toBe(r.access);
      expect(g.operator, `row ${i}: operator`).toBe(r.operator);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.parkAndRide, `row ${i}: parkAndRide`).toBe(r.parkAndRide);
      expect(g.url, `row ${i}: url`).toBe(r.url);
    }
  });
});
