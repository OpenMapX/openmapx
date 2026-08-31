import { readFileSync } from "node:fs";
import { join } from "node:path";
import { token } from "@openmapx/integration-framework/strings";
import type {
  BnlsFrRecord,
  I18nTokenLike,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { mapFrBnlsPayload } from "../fr-bnls-mapper.js";
import { parseFrBnlsStatic } from "../fr-bnls-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference, lifted verbatim from the prior bnls-fr.ts.
 * Source id is `fr-bnls` (prefix `fr-bnls:`).
 */

const TYPE_MAP: Record<string, ParkingType> = {
  ouvrage: "garage",
  enclos_en_surface: "surface",
};

function refTariffRows(record: BnlsFrRecord): [I18nTokenLike, string][] | undefined {
  const rows: [I18nTokenLike, string][] = [];
  if (record.cost_1h != null) rows.push([token("tariff.dur1h"), `€${record.cost_1h.toFixed(2)}`]);
  if (record.cost_2h != null) rows.push([token("tariff.dur2h"), `€${record.cost_2h.toFixed(2)}`]);
  if (record.cost_3h != null) rows.push([token("tariff.dur3h"), `€${record.cost_3h.toFixed(2)}`]);
  if (record.cost_4h != null) rows.push([token("tariff.dur4h"), `€${record.cost_4h.toFixed(2)}`]);
  if (record.cost_24h != null) {
    rows.push([token("tariff.dur1day"), `€${record.cost_24h.toFixed(2)}`]);
  }
  if (record.resident_sub != null) {
    rows.push([token("tariff.monthlyResident"), `€${record.resident_sub.toFixed(2)}`]);
  }
  if (record.non_resident_sub != null) {
    rows.push([token("tariff.monthly"), `€${record.non_resident_sub.toFixed(2)}`]);
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
    id: `fr-bnls:${record.id}`,
    name: record.name || "Parking",
    coordinates: [lng, lat],
    sources: ["fr-bnls"],
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
  return parseFrBnlsStatic(FIXTURE).map((row) => mapFrBnlsPayload(row.poiId, row.payload));
}

parkingEquivalenceContract({
  name: "French national parking database",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "capacity",
    "hasRealtimeData",
    "disabledSpaces",
    "chargingSpaces",
    "maxHeight",
    "fee",
    "feeDescription",
    "tariffRows",
    "access",
    "address",
    "parkAndRide",
    "url",
  ],
});
