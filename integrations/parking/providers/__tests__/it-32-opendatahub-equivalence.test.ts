import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OdhParkingMeasurement,
  OdhParkingStation,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIt32OpendatahubBundled } from "../it-32-opendatahub-bundled-parser.js";
import {
  mapIt32OpendatahubPayload,
  mergeIt32OpendatahubLive,
} from "../it-32-opendatahub-mapper.js";
import {
  parkingEquivalenceContract,
  stubSuccessfulFetchResponse,
} from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference, lifted from the prior `opendatahub-it.ts`
 * `buildFacilities` function. Source id is `it-32-opendatahub` (prefix
 * `it-32-opendatahub:`). The fixture covers: a station with live `free`
 * directly (BZ-001), one with `occupied` only (MR-014 then overlaid by
 * a later `free`), one with stale `occupied` outside the MAX_AGE window
 * (BR-007 — should be dropped by the parser), and a station with bad
 * coordinates (INVALID — skipped).
 */

const STATIONS_FIXTURE = readFileSync(join(__dirname, "fixtures", "opendatahub-it-stations.json"));
const MEAS_FIXTURE = readFileSync(join(__dirname, "fixtures", "opendatahub-it-measurements.json"));
const MEAS_URL =
  "https://mobility.api.opendatahub.com/v2/flat/ParkingStation/*/latest?select=scode,tname,mvalue,mvalidtime&where=sactive.eq.true&limit=500&shownull=false&distinct=true";
const FIXED_NOW = Date.parse("2026-05-23T12:00:00.000Z");

const MEASUREMENT_MAX_AGE_MS = 60 * 60 * 1000;

function refDeriveLayout(station: OdhParkingStation): ParkingType {
  const layout = station.smetadata?.netex_parking?.layout;
  if (layout === "underground") return "underground";
  if (layout === "openSpace") return "surface";
  if (layout === "multiStorey" || layout === "multistorey") return "garage";
  return "unknown";
}

function refStationName(station: OdhParkingStation): string {
  const meta = station.smetadata as Record<string, unknown>;
  return (
    (meta?.name_en as string) ??
    (meta?.name_EN as string) ??
    (meta?.name_de as string) ??
    (meta?.name_DE as string) ??
    (meta?.name_it as string) ??
    (meta?.name_IT as string) ??
    (meta?.standard_name as string) ??
    station.sname
  );
}

function refBuildFacilities(now: number): ParkingFacility[] {
  const stations = (JSON.parse(STATIONS_FIXTURE.toString("utf-8")) as { data: OdhParkingStation[] })
    .data;
  const measurements = (
    JSON.parse(MEAS_FIXTURE.toString("utf-8")) as { data: OdhParkingMeasurement[] }
  ).data;

  const measMap = new Map<string, { occupied?: number; free?: number }>();
  for (const m of measurements) {
    if (m.tname !== "occupied" && m.tname !== "free") continue;
    const validTime = new Date(m.mvalidtime);
    if (now - validTime.getTime() > MEASUREMENT_MAX_AGE_MS) continue;
    const existing = measMap.get(m.scode) ?? {};
    if (m.tname === "occupied") existing.occupied = m.mvalue;
    if (m.tname === "free") existing.free = m.mvalue;
    measMap.set(m.scode, existing);
  }

  return stations
    .map((station): ParkingFacility | null => {
      const lng = station.scoordinate?.x;
      const lat = station.scoordinate?.y;
      if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) return null;

      const capacity = station.smetadata?.capacity;
      const meas = measMap.get(station.scode);
      const hasRealtime =
        meas !== undefined && (meas.free !== undefined || meas.occupied !== undefined);

      let freeSpaces: number | undefined;
      if (meas?.free !== undefined) freeSpaces = meas.free;
      else if (meas?.occupied !== undefined && capacity) {
        freeSpaces = Math.max(0, capacity - meas.occupied);
      }

      const hasCharging = station.smetadata?.netex_parking?.charging === true;
      const municipality = station.smetadata?.municipality;
      return {
        id: `it-32-opendatahub:${station.scode}`,
        name: refStationName(station),
        coordinates: [lng, lat] as [number, number],
        sources: ["it-32-opendatahub"],
        parkingType: refDeriveLayout(station),
        capacity,
        freeSpaces,
        hasRealtimeData: hasRealtime,
        fee: "unknown" as const,
        address: municipality ? `${municipality}, South Tyrol` : "South Tyrol, Italy",
        chargingSpaces: hasCharging ? 1 : undefined,
        chargingDetails: hasCharging ? "EV Charging Available" : undefined,
      };
    })
    .filter((f): f is ParkingFacility => f !== null);
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseIt32OpendatahubBundled(STATIONS_FIXTURE, {
    log: noopLog,
  });
  return rows.map((row) => {
    const base = mapIt32OpendatahubPayload(row.poiId, row.payload);
    const merged = mergeIt32OpendatahubLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  stubSuccessfulFetchResponse(MEAS_URL, MEAS_FIXTURE.toString("utf-8"));
});

parkingEquivalenceContract({
  name: "OpenDataHub South Tyrol",
  reference: () => refBuildFacilities(FIXED_NOW),
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "capacity",
    "freeSpaces",
    "hasRealtimeData",
    "fee",
    "address",
    "chargingSpaces",
    "chargingDetails",
  ],
});

describe("opendatahub-it parser+mapper equivalence to pre-migration impl", () => {
  it("skips stations whose latest measurement is older than 1h", async () => {
    const got = await runMigrated();
    // BR-007's `occupied` measurement is older than MAX_AGE → no live row.
    const brixen = got.find((f) => f.id === "it-32-opendatahub:BR-007");
    expect(brixen?.hasRealtimeData).toBe(false);
    expect(brixen?.freeSpaces).toBeUndefined();
  });
});
