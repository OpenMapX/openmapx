import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { mapEsCtBarcelonaPayload } from "../es-ct-barcelona-mapper.js";
import { parseEsCtBarcelonaStatic } from "../es-ct-barcelona-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference, lifted verbatim from the prior barcelona-es.ts.
 * Source id is `es-ct-barcelona` (prefix `es-ct-barcelona:`).
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
    id: `es-ct-barcelona:${record.register_id}`,
    name: record.name || "Parking",
    coordinates: coords,
    sources: ["es-ct-barcelona"],
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
  return parseEsCtBarcelonaStatic(FIXTURE).map((row) =>
    mapEsCtBarcelonaPayload(row.poiId, row.payload),
  );
}

parkingEquivalenceContract({
  name: "Barcelona",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "hasRealtimeData",
    "fee",
    "feeDescription",
    "access",
    "address",
    "state",
  ],
});
