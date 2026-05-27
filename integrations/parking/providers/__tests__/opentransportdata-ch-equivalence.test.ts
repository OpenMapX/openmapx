import { readFileSync } from "node:fs";
import { join } from "node:path";
import { token } from "@openmapx/integration-framework/strings";
import type {
  I18nTokenLike,
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { afterEach, describe, expect, it } from "vitest";
import { parseOpenTransportDataChBundled } from "../opentransportdata-ch-bundled-parser.js";
import {
  mapOpenTransportDataChPayload,
  mergeOpenTransportDataChLive,
} from "../opentransportdata-ch-mapper.js";

/**
 * Pre-migration reference, lifted from the prior `opentransportdata-ch.ts`
 * `featureToFacility`. Source id (`opentransportdata-ch-parking`) and prefix
 * (`otdch-parking:`) unchanged. Tests stay focused on the fields the static
 * payload + live `freeSpaces` carry; live-only fields (dataUpdatedAt,
 * realtimeDataUpdatedAt) are stripped because the legacy mapper never wrote
 * them.
 */

const FIXTURE = readFileSync(join(__dirname, "fixtures", "opentransportdata-ch-sample.json"));

const SOURCE_ATTRIBUTION: ParkingSourceAttribution = {
  contributor: "OpenTransportData.swiss",
  license: "O-By 1.0",
  url: "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking",
};

interface RefFeature {
  id: string;
  geometry?: {
    geometries?: Array<{ type?: string; coordinates?: [number, number] }>;
  };
  properties: Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function pickPoint(feature: RefFeature): [number, number] | null {
  const point = feature.geometry?.geometries?.find(
    (g): g is { type: "Point"; coordinates: [number, number] } =>
      g.type === "Point" &&
      Array.isArray(g.coordinates) &&
      g.coordinates.length === 2 &&
      Number.isFinite(g.coordinates[0]) &&
      Number.isFinite(g.coordinates[1]),
  );
  return point?.coordinates ?? null;
}

function mapParkingType(type: string): ParkingType {
  if (type.includes("UNDERGROUND")) return "underground";
  if (type.includes("PARK_AND_RAIL") || type === "PARKING") return "surface";
  if (type.startsWith("BIKE_")) return "surface";
  return "unknown";
}

function totalCapacity(caps: Array<{ total?: number }>): number | undefined {
  const totals = caps.map((c) => c.total).filter((v): v is number => typeof v === "number");
  return totals.length ? totals.reduce((s, v) => s + v, 0) : undefined;
}

function getCapByType(
  caps: Array<{ categoryType?: string; total?: number }>,
  cat: string,
): number | undefined {
  return caps.find((c) => c.categoryType === cat)?.total;
}

function formatChf(cents: number | null | undefined): string | undefined {
  if (cents == null) return undefined;
  return `CHF ${(cents / 100).toFixed(2)}`;
}

function durationToken(minutes: number): I18nTokenLike {
  if (minutes % 1440 === 0) return token("tariff.durDays", { count: minutes / 1440 });
  if (minutes % 60 === 0) return token("tariff.durHours", { count: minutes / 60 });
  return token("tariff.durMinutes", { count: minutes });
}

function buildTariffRows(pricing: Record<string, unknown>): [I18nTokenLike, string][] | undefined {
  if (!pricing) return undefined;
  const rows: [I18nTokenLike, string][] = [];
  for (const seg of pricing.priceSegments ?? []) {
    const label = durationToken(seg.startingFrom ?? 0);
    const price = formatChf(seg.price);
    if (price) rows.push([label, price]);
  }
  const day = formatChf(pricing.maximumDayPrice);
  if (day) rows.push([token("tariff.maxDayPrice"), day]);
  const monthly = formatChf(pricing.monthlyTicketPrice);
  if (monthly) rows.push([token("tariff.monthlyPass"), monthly]);
  const yearly = formatChf(pricing.yearlyTicketPrice);
  if (yearly) rows.push([token("tariff.yearlyPass"), yearly]);
  return rows.length ? rows : undefined;
}

function operationHours(op: Record<string, unknown>): string | undefined {
  if (!op) return undefined;
  const days = op.daysOfWeek ?? [];
  if (days.length === 7 && op.operatingFrom === "00:00:00" && op.operatingTo === "00:00:00") {
    return "24/7";
  }
  if (op.operatingFrom && op.operatingTo) {
    return `${op.operatingFrom.slice(0, 5)}-${op.operatingTo.slice(0, 5)}`;
  }
  return undefined;
}

function firstAction(cta: Record<string, Record<string, string>> | undefined): string | undefined {
  if (!cta) return undefined;
  for (const k of ["externalDesktop", "externalMobile", "sbbDesktop", "sbbMobile"]) {
    const e = cta[k];
    if (e) return e.en || e.de || e.fr || e.it;
  }
  return undefined;
}

function addressLine(addr: Record<string, unknown>): string | undefined {
  return [addr?.addressLine, addr?.postalCode, addr?.city].filter(Boolean).join(", ") || undefined;
}

function refFeatureToFacility(feature: RefFeature): ParkingFacility | null {
  const coords = pickPoint(feature);
  const properties = feature.properties;
  if (!coords || !properties || !feature.id) return null;
  if (properties.parkingFacilityCategory && properties.parkingFacilityCategory !== "CAR") {
    return null;
  }
  const capacity = totalCapacity(properties.capacities ?? []);
  const occupancy = properties.currentEstimatedOccupancy;
  const freeSpaces =
    capacity != null && occupancy != null
      ? Math.max(0, Math.round(capacity * (1 - occupancy)))
      : undefined;
  const tariffRows = buildTariffRows(properties.pricingModel);
  const type: string = properties.parkingFacilityType ?? "";
  return {
    access: properties.publicAccess ? "public" : "private",
    address: addressLine(properties.address),
    capacity,
    chargingSpaces: getCapByType(properties.capacities ?? [], "WITH_CHARGING_STATION"),
    disabledSpaces: getCapByType(properties.capacities ?? [], "DISABLED_PARKING_SPACE"),
    fee:
      tariffRows && tariffRows.length > 0
        ? "paid"
        : properties.publicAccess
          ? "unknown"
          : "unknown",
    feeDescription:
      properties.additionalInformationForCustomers || properties.bookingSystem || undefined,
    freeSpaces,
    hasRealtimeData: freeSpaces !== undefined,
    id: `otdch-parking:${feature.id}`,
    name: properties.displayName || "Parking",
    openingHours: operationHours(properties.operationTime),
    operator: properties.operator || undefined,
    parkAndRide: type === "PARK_AND_RAIL",
    parkingType: mapParkingType(type),
    paymentMethods: properties.bookingSystem || undefined,
    sources: ["opentransportdata-ch-parking"],
    sourceAttribution: SOURCE_ATTRIBUTION,
    sourceName: "OpenTransportData.swiss",
    sourceUrl: "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking",
    state: "open",
    tariffRows,
    url: firstAction(properties.callToAction),
    coordinates: coords,
  };
}

function runReference(): ParkingFacility[] {
  const data = JSON.parse(FIXTURE.toString("utf-8")) as { features: RefFeature[] };
  return data.features.map(refFeatureToFacility).filter((f): f is ParkingFacility => f !== null);
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseOpenTransportDataChBundled(FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapOpenTransportDataChPayload(row.poiId, row.payload);
    const merged = mergeOpenTransportDataChLive(base, live.get(row.poiId) ?? null);
    // Pre-migration code didn't emit dataUpdatedAt/realtimeDataUpdatedAt for
    // this provider — strip so equivalence stays focused on shared fields.
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

afterEach(() => {});

describe("opentransportdata-ch parser+mapper equivalence to pre-migration impl", () => {
  it("produces field-by-field-identical car facilities", async () => {
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
      expect(g.sourceName, `row ${i}: sourceName`).toBe(r.sourceName);
      expect(g.sourceUrl, `row ${i}: sourceUrl`).toBe(r.sourceUrl);
      expect(g.sourceAttribution, `row ${i}: sourceAttribution`).toEqual(r.sourceAttribution);
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.disabledSpaces, `row ${i}: disabledSpaces`).toBe(r.disabledSpaces);
      expect(g.chargingSpaces, `row ${i}: chargingSpaces`).toBe(r.chargingSpaces);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.feeDescription, `row ${i}: feeDescription`).toBe(r.feeDescription);
      expect(g.tariffRows, `row ${i}: tariffRows`).toEqual(r.tariffRows);
      expect(g.access, `row ${i}: access`).toBe(r.access);
      expect(g.operator, `row ${i}: operator`).toBe(r.operator);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.openingHours, `row ${i}: openingHours`).toBe(r.openingHours);
      expect(g.state, `row ${i}: state`).toBe(r.state);
      expect(g.parkAndRide, `row ${i}: parkAndRide`).toBe(r.parkAndRide);
      expect(g.paymentMethods, `row ${i}: paymentMethods`).toBe(r.paymentMethods);
      expect(g.url, `row ${i}: url`).toBe(r.url);
    }
  });

  it("filters out bike-only facilities", async () => {
    const got = await runMigrated();
    const ids = got.map((f) => f.id);
    expect(ids).not.toContain("otdch-parking:bern-bike");
    expect(ids).toContain("otdch-parking:bern-pr");
    expect(ids).toContain("otdch-parking:zurich-ug");
  });
});
