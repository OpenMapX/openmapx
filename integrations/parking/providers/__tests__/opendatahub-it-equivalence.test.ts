import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OdhParkingMeasurement,
  OdhParkingStation,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOdhItBundled } from "../opendatahub-it-bundled-parser.js";
import { mapOdhItPayload, mergeOdhItLive } from "../opendatahub-it-mapper.js";

/**
 * Pre-migration reference, lifted from the prior `opendatahub-it.ts`
 * `buildFacilities` function. Source id (`opendatahub-it`) and prefix
 * (`odh:`) unchanged. The fixture covers: a station with live `free`
 * directly (BZ-001), one with `occupied` only (MR-014 then overlaid by
 * a later `free`), one with stale `occupied` outside the MAX_AGE window
 * (BR-007 — should be dropped by the parser), and a station with bad
 * coordinates (INVALID — skipped).
 */

const STATIONS_FIXTURE = readFileSync(join(__dirname, "fixtures", "opendatahub-it-stations.json"));
const MEAS_FIXTURE = readFileSync(join(__dirname, "fixtures", "opendatahub-it-measurements.json"));
const MEAS_URL =
  "https://mobility.api.opendatahub.com/v2/flat/ParkingStation/*/latest?select=scode,tname,mvalue,mvalidtime&where=sactive.eq.true&limit=500&shownull=false&distinct=true";

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
        id: `odh:${station.scode}`,
        name: refStationName(station),
        coordinates: [lng, lat] as [number, number],
        sources: ["opendatahub-it"],
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
  const { static: rows, live } = await parseOdhItBundled(STATIONS_FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapOdhItPayload(row.poiId, row.payload);
    const merged = mergeOdhItLive(base, live.get(row.poiId) ?? null);
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opendatahub-it parser+mapper equivalence to pre-migration impl", () => {
  const FIXED_NOW = Date.parse("2026-05-23T12:00:00.000Z");

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === MEAS_URL) {
          return new Response(MEAS_FIXTURE.toString("utf-8"), { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
  });

  it("produces field-by-field-identical facilities", async () => {
    const ref = refBuildFacilities(FIXED_NOW);
    const got = await runMigrated();

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
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.address, `row ${i}: address`).toBe(r.address);
      expect(g.chargingSpaces, `row ${i}: chargingSpaces`).toBe(r.chargingSpaces);
      expect(g.chargingDetails, `row ${i}: chargingDetails`).toBe(r.chargingDetails);
    }
  });

  it("skips stations whose latest measurement is older than 1h", async () => {
    const got = await runMigrated();
    // BR-007's `occupied` measurement is older than MAX_AGE → no live row.
    const brixen = got.find((f) => f.id === "odh:BR-007");
    expect(brixen?.hasRealtimeData).toBe(false);
    expect(brixen?.freeSpaces).toBeUndefined();
  });
});
