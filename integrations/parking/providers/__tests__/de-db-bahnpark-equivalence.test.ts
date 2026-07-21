import { readFileSync } from "node:fs";
import { join } from "node:path";
import { token } from "@openmapx/integration-framework/strings";
import type {
  DbBahnParkFacility,
  I18nTokenLike,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapDeDbBahnParkPayload } from "../de-db-bahnpark-mapper.js";
import { parseDeDbBahnParkStatic } from "../de-db-bahnpark-parser.js";

/**
 * Pre-migration reference, lifted verbatim from the prior db-bahnpark.ts.
 * Source id is `de-db-bahnpark` (prefix `de-db-bahnpark:`).
 */

const TYPE_MAP: Record<string, ParkingType> = {
  Parkhaus: "garage",
  Tiefgarage: "underground",
  Parkplatz: "surface",
  "P+R-Anlage": "surface",
};

function refMapType(typeName?: string): ParkingType {
  if (!typeName) return "unknown";
  return TYPE_MAP[typeName] ?? "unknown";
}

const DURATION_TOKEN: Record<string, I18nTokenLike> = {
  "20min": token("tariff.dur20min"),
  "30min": token("tariff.dur30min"),
  "1hour": token("tariff.dur1h"),
  "1day": token("tariff.dur1day"),
  "1dayPCard": token("tariff.dur1dayPCard"),
  "1week": token("tariff.dur1week"),
  "1weekPCard": token("tariff.dur1weekPCard"),
  "1monthVendingMachine": token("tariff.dur1month"),
  "1monthLongTerm": token("tariff.dur1monthLong"),
  "1monthReservation": token("tariff.dur1monthReserved"),
};

function refExtractName(f: DbBahnParkFacility): string {
  const display = f.name.find((n) => n.context === "DISPLAY");
  const name = f.name.find((n) => n.context === "NAME");
  return display?.name ?? name?.name ?? `Parking ${f.id}`;
}

function refExtractCapacity(f: DbBahnParkFacility): { total?: number; disabled?: number } {
  let total: number | undefined;
  let disabled: number | undefined;
  for (const cap of f.capacity ?? []) {
    const val = Number.parseInt(cap.total, 10);
    if (Number.isNaN(val)) continue;
    if (cap.type === "PARKING") total = val;
    if (cap.type === "HANDICAPPED_PARKING" && val > 0) disabled = val;
  }
  return { total, disabled };
}

function refBuildTariffRows(f: DbBahnParkFacility): [I18nTokenLike | string, string][] | undefined {
  const prices = f.tariff?.prices;
  if (!prices || prices.length === 0) return undefined;
  const rows: [I18nTokenLike | string, string][] = [];
  for (const p of prices) {
    if (p.price == null || !p.duration) continue;
    if (p.group?.groupName !== "standard") continue;
    const label = DURATION_TOKEN[p.duration] ?? p.duration;
    rows.push([label, `€${p.price.toFixed(2)}`]);
  }
  return rows.length > 0 ? rows : undefined;
}

function refFacilityToParking(f: DbBahnParkFacility): ParkingFacility | null {
  const loc = f.address?.location;
  if (!loc) return null;
  const { total, disabled } = refExtractCapacity(f);
  const isOutOfService = f.access?.outOfService?.isOutOfService === true;
  const addressParts = [f.address?.streetAndNumber, f.address?.zip, f.address?.city].filter(
    Boolean,
  );
  const heightCm = f.access?.restrictions?.clearance?.height;
  const maxHeight = heightCm ? Number.parseInt(heightCm, 10) : undefined;

  return {
    id: `de-db-bahnpark:${f.id}`,
    name: refExtractName(f),
    coordinates: [loc.longitude, loc.latitude],
    sources: ["de-db-bahnpark"],
    parkingType: refMapType(f.type?.name),
    capacity: total,
    hasRealtimeData: false,
    disabledSpaces: disabled,
    chargingSpaces: f.equipment?.charging?.hasChargingStation ? 1 : undefined,
    maxHeight: maxHeight && !Number.isNaN(maxHeight) ? maxHeight : undefined,
    fee: f.tariff?.prices?.some((p) => p.price != null) ? "paid" : "unknown",
    tariffRows: refBuildTariffRows(f),
    operator: f.operator?.name ?? "DB BahnPark",
    address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
    openingHours: f.access?.openingHours?.is24h
      ? "24/7"
      : (f.access?.openingHours?.text ?? undefined),
    parkAndRide: f.type?.name === "P+R-Anlage" || undefined,
    nearestStation: f.station?.name ?? undefined,
    chargingDetails: f.equipment?.charging?.details ?? undefined,
    paymentMethods: f.tariff?.information?.dynamic?.tariffPaymentOptions ?? undefined,
    url: f.url ?? undefined,
    state: isOutOfService ? "closed" : "open",
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "db-bahnpark-sample.json"));

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as DbBahnParkFacility[];
  const out: ParkingFacility[] = [];
  for (const f of data) {
    const p = refFacilityToParking(f);
    if (p) out.push(p);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseDeDbBahnParkStatic(FIXTURE).map((row) =>
    mapDeDbBahnParkPayload(row.poiId, row.payload),
  );
}

describe("db-bahnpark parser+mapper equivalence to pre-migration in-memory parser", () => {
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
      expect(g.tariffRows, `row ${i}: tariffRows`).toEqual(r.tariffRows);
      expect(g.operator, `row ${i}: operator`).toBe(r.operator);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.openingHours, `row ${i}: openingHours`).toBe(r.openingHours);
      expect(g.parkAndRide, `row ${i}: parkAndRide`).toBe(r.parkAndRide);
      expect(g.nearestStation, `row ${i}: nearestStation`).toBe(r.nearestStation);
      expect(g.chargingDetails, `row ${i}: chargingDetails`).toBe(r.chargingDetails);
      expect(g.paymentMethods, `row ${i}: paymentMethods`).toBe(r.paymentMethods);
      expect(g.url, `row ${i}: url`).toBe(r.url);
      expect(g.state, `row ${i}: state`).toBe(r.state);
    }
  });
});
