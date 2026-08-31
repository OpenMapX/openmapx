import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { mapAt9ViennaPayload } from "../at-9-vienna-mapper.js";
import { parseAt9ViennaStatic } from "../at-9-vienna-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference, lifted verbatim from the prior vienna-at.ts.
 * Source id is `at-9-vienna` (prefix `at-9-vienna:`).
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
    id: `at-9-vienna:${props.GARAGE_ID}`,
    name: props.BEZEICHNUNG || "Parking",
    coordinates: [lng, lat],
    sources: ["at-9-vienna"],
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
  return parseAt9ViennaStatic(FIXTURE).map((row) => mapAt9ViennaPayload(row.poiId, row.payload));
}

parkingEquivalenceContract({
  name: "Vienna",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "hasRealtimeData",
    "disabledSpaces",
    "fee",
    "access",
    "operator",
    "address",
    "parkAndRide",
    "url",
  ],
});
