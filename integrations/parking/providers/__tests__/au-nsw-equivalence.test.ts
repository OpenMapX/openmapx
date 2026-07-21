import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuNswBundled } from "../au-nsw-bundled-parser.js";
import { mapAuNswPayload, mergeAuNswLive } from "../au-nsw-mapper.js";

/**
 * Pre-migration reference behaviour: for each visible facility build the
 * ParkingFacility from list entry + KNOWN_FACILITIES fallback + the
 * per-facility detail response. Source id is `au-nsw` (prefix `au-nsw:`).
 */

const LIST = readFileSync(join(__dirname, "fixtures", "nsw-au-list.json"));
const DETAIL_26 = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "nsw-au-detail-26.json"), "utf-8"),
);
const DETAIL_486 = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "nsw-au-detail-486.json"), "utf-8"),
);

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function parseInt2(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

interface RefDetail {
  spots: string;
  location: { latitude: string; longitude: string; address: string; suburb: string };
  occupancy: { total: string | null };
  MessageDate: string;
}

function refBuild(
  entry: { facility_id: string; facility_name: string },
  detail: RefDetail,
): ParkingFacility {
  const lat = Number(detail.location.latitude);
  const lng = Number(detail.location.longitude);
  const spots = parseInt2(detail.spots);
  const total = parseInt2(detail.occupancy.total);
  const capacity = spots != null && spots > 0 ? spots : undefined;
  const freeSpaces = spots != null && total != null ? Math.max(0, spots - total) : undefined;
  const hasRealtime = spots != null && total != null;

  return {
    id: `au-nsw:${entry.facility_id}`,
    name: entry.facility_name,
    coordinates: [lng, lat],
    sources: ["au-nsw"],
    parkingType: "surface",
    capacity,
    freeSpaces,
    hasRealtimeData: hasRealtime,
    dataUpdatedAt: detail.MessageDate,
    realtimeDataUpdatedAt: hasRealtime ? detail.MessageDate : undefined,
    fee: "free",
    parkAndRide: true,
    address: `${detail.location.address}, ${detail.location.suburb}`,
  };
}

function runReference(): ParkingFacility[] {
  return [
    refBuild({ facility_id: "26", facility_name: "Park&Ride - Tallawong P1" }, DETAIL_26),
    refBuild({ facility_id: "486", facility_name: "Park&Ride - Ashfield" }, DETAIL_486),
  ];
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseAuNswBundled(LIST, { log: noopLog });
  return rows.map((row) => {
    const base = mapAuNswPayload(row.poiId, row.payload);
    return mergeAuNswLive(base, live.get(row.poiId) ?? null);
  });
}

beforeEach(() => {
  process.env.NSW_TRANSPORT_API_KEY = "test-key";
  // Detail fixtures' MessageDate values are emitted without a timezone, so
  // Date.parse interprets them as local time. Anchor system time to the
  // same local-time base so the staleness gate (30 min) doesn't trip
  // regardless of the host TZ.
  vi.useFakeTimers();
  const localFixtureBase = new Date("2024-11-25T11:09:00");
  vi.setSystemTime(new Date(localFixtureBase.getTime() + 5 * 60 * 1000));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("facility=26")) {
        return new Response(JSON.stringify(DETAIL_26), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("facility=486")) {
        return new Response(JSON.stringify(DETAIL_486), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env.NSW_TRANSPORT_API_KEY = undefined;
});

describe("nsw-au parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same facility ids in the same order", async () => {
    const ref = runReference();
    const got = await runMigrated();
    expect(got.map((f) => f.id)).toEqual(ref.map((f) => f.id));
  });

  it("produces field-by-field-identical facilities", async () => {
    const ref = runReference();
    const got = await runMigrated();
    expect(got).toHaveLength(ref.length);
    for (let i = 0; i < ref.length; i++) {
      const r = ref[i];
      const g = got[i];
      expect(g.id, `row ${i}: id`).toBe(r.id);
      expect(g.name, `row ${i}: name`).toBe(r.name);
      expect(g.coordinates[0], `row ${i}: lng`).toBeCloseTo(r.coordinates[0], 6);
      expect(g.coordinates[1], `row ${i}: lat`).toBeCloseTo(r.coordinates[1], 6);
      expect(g.sources, `row ${i}: sources`).toEqual(r.sources);
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.dataUpdatedAt, `row ${i}: dataUpdatedAt`).toBe(r.dataUpdatedAt);
      expect(g.realtimeDataUpdatedAt, `row ${i}: realtimeDataUpdatedAt`).toBe(
        r.realtimeDataUpdatedAt,
      );
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.parkAndRide, `row ${i}: parkAndRide`).toBe(r.parkAndRide);
      expect(g.address, `row ${i}: address`).toBe(r.address);
    }
  });
});
