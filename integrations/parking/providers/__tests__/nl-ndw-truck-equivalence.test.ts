import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseNlNdwTruckBundled } from "../nl-ndw-truck-bundled-parser.js";
import { mapNlNdwTruckPayload, mergeNlNdwTruckLive } from "../nl-ndw-truck-mapper.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T11:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Pre-migration reference, lifted from the prior `ndw-truck-nl.ts`
 * `buildFacilities` function. Source id is `nl-ndw-truck` (prefix
 * `nl-ndw-truck:`).
 */

const TABLE_FIXTURE = readFileSync(join(__dirname, "fixtures", "ndw-truck-nl-table.xml"));
const STATUS_FIXTURE = readFileSync(join(__dirname, "fixtures", "ndw-truck-nl-status.xml"));
const STATUS_URL = "https://opendata.ndw.nu/Truckparking_Parking_Status.xml";

function refBuild(): ParkingFacility[] {
  const records = parseDatexParkingTable(TABLE_FIXTURE.toString("utf-8"));
  const statuses = parseDatexParkingStatus(STATUS_FIXTURE.toString("utf-8"));
  const statusMap = new Map<string, DatexParkingStatus>(statuses.map((s) => [s.recordId, s]));

  return records.map((rec) => {
    const status = statusMap.get(rec.id);
    const hasRealtime = status !== undefined;
    let freeSpaces: number | undefined;
    let state: "open" | "closed" | "unknown" = "unknown";
    if (status) {
      freeSpaces = status.vacantSpaces;
      if (status.siteStatus === "closed") state = "closed";
      else if (status.siteStatus) state = "open";
    }
    const hasCharging = rec.equipmentTypes?.includes("electricChargingStation") ?? false;
    return {
      id: `nl-ndw-truck:${rec.id}`,
      name: rec.name,
      coordinates: [rec.longitude, rec.latitude] as [number, number],
      sources: ["nl-ndw-truck"],
      parkingType: "surface" as ParkingType,
      capacity: rec.totalSpaces,
      freeSpaces,
      hasRealtimeData: hasRealtime,
      fee:
        rec.freeOfCharge === true
          ? ("free" as const)
          : rec.freeOfCharge === false
            ? ("paid" as const)
            : ("unknown" as const),
      state,
      chargingSpaces: hasCharging ? 1 : undefined,
      chargingDetails: hasCharging ? "EV Charging Available" : undefined,
    };
  });
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseNlNdwTruckBundled(TABLE_FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapNlNdwTruckPayload(row.poiId, row.payload);
    const merged = mergeNlNdwTruckLive(base, live.get(row.poiId) ?? null);
    // Pre-migration impl didn't write dataUpdatedAt/realtimeDataUpdatedAt —
    // strip before comparing so equivalence stays focused on shared fields.
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ndw-truck-nl parser+mapper equivalence to pre-migration in-memory impl", () => {
  it("produces field-by-field-identical facilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === STATUS_URL) {
          return new Response(STATUS_FIXTURE.toString("utf-8"), { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const ref = refBuild();
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
      expect(g.state, `row ${i}: state`).toBe(r.state);
      expect(g.chargingSpaces, `row ${i}: chargingSpaces`).toBe(r.chargingSpaces);
      expect(g.chargingDetails, `row ${i}: chargingDetails`).toBe(r.chargingDetails);
    }
  });

  it("degrades gracefully when the status feed errors out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const got = await runMigrated();
    // Static rows still emit but `hasRealtimeData` is false everywhere.
    expect(got.every((f) => f.hasRealtimeData === false)).toBe(true);
    expect(got.map((f) => f.id)).toEqual(["nl-ndw-truck:NL-TRK-001", "nl-ndw-truck:NL-TRK-002"]);
  });
});
