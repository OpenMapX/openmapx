import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutobahnParkingLorry, ParkingFacility } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDeAutobahnBundled } from "../de-autobahn-bundled-parser.js";
import { mapDeAutobahnPayload } from "../de-autobahn-mapper.js";

/**
 * Pre-migration reference, lifted from the prior `autobahn-de.ts`
 * `itemToFacility` + `fetchAllFacilities` (federated per-road fan-out).
 * Source id is `de-autobahn` (prefix `de-autobahn:`). Static-only:
 * the upstream API has no real-time occupancy.
 */

const ROADS_FIXTURE = readFileSync(join(__dirname, "fixtures", "autobahn-de-roads.json"));
const A1_FIXTURE = readFileSync(join(__dirname, "fixtures", "autobahn-de-a1.json"));
const A7_FIXTURE = readFileSync(join(__dirname, "fixtures", "autobahn-de-a7.json"));
const BASE_URL = "https://verkehr.autobahn.de/o/autobahn";

function refParseCapacity(description: string[]): { car?: number; truck?: number } {
  let car: number | undefined;
  let truck: number | undefined;
  for (const line of description) {
    const carMatch = line.match(/PKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (carMatch) car = Number.parseInt(carMatch[1], 10);
    const truckMatch = line.match(/LKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (truckMatch) truck = Number.parseInt(truckMatch[1], 10);
  }
  return { car, truck };
}

function refHasAmenity(
  icons: AutobahnParkingLorry["lorryParkingFeatureIcons"],
  keyword: string,
): boolean {
  return icons?.some((i) => i.icon.includes(keyword) || i.description.includes(keyword)) ?? false;
}

function refItemToFacility(item: AutobahnParkingLorry): ParkingFacility | null {
  const lat = Number.parseFloat(item.coordinate?.lat);
  const lng = Number.parseFloat(item.coordinate?.long);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (item.future === true) return null;

  const { car, truck } = refParseCapacity(item.description ?? []);
  const totalCapacity = (car ?? 0) + (truck ?? 0);
  const isBlocked = item.isBlocked === "true";
  const icons = item.lorryParkingFeatureIcons ?? [];
  const hasCharging = refHasAmenity(icons, "charging") || refHasAmenity(icons, "Ladestation");

  return {
    id: `de-autobahn:${item.identifier}`,
    name: item.subtitle || item.title || "Rastplatz",
    coordinates: [lng, lat],
    sources: ["de-autobahn"],
    parkingType: "surface",
    capacity: totalCapacity > 0 ? totalCapacity : undefined,
    hasRealtimeData: false,
    fee: "free",
    state: isBlocked ? "closed" : "open",
    chargingSpaces: hasCharging ? 1 : undefined,
    chargingDetails: hasCharging ? "EV Charging Available" : undefined,
  };
}

function refBuildAll(): ParkingFacility[] {
  const a1 = (JSON.parse(A1_FIXTURE.toString("utf-8")) as { parking_lorry: AutobahnParkingLorry[] })
    .parking_lorry;
  const a7 = (JSON.parse(A7_FIXTURE.toString("utf-8")) as { parking_lorry: AutobahnParkingLorry[] })
    .parking_lorry;
  const all = [...a1, ...a7].map(refItemToFacility).filter((f): f is ParkingFacility => f !== null);
  // Deduplicate by identifier (first occurrence wins) — mirrors pre-migration.
  const seen = new Map<string, ParkingFacility>();
  for (const f of all) if (!seen.has(f.id)) seen.set(f.id, f);
  return Array.from(seen.values());
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows } = await parseDeAutobahnBundled(ROADS_FIXTURE, { log: noopLog });
  return rows.map((row) => mapDeAutobahnPayload(row.poiId, row.payload));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("autobahn-de parser+mapper equivalence to pre-migration in-memory impl", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === `${BASE_URL}/A1/services/parking_lorry`) {
          return new Response(A1_FIXTURE.toString("utf-8"), { status: 200 });
        }
        if (url === `${BASE_URL}/A7/services/parking_lorry`) {
          return new Response(A7_FIXTURE.toString("utf-8"), { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
  });

  it("produces field-by-field-identical facilities", async () => {
    const ref = refBuildAll();
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
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.state, `row ${i}: state`).toBe(r.state);
      expect(g.chargingSpaces, `row ${i}: chargingSpaces`).toBe(r.chargingSpaces);
      expect(g.chargingDetails, `row ${i}: chargingDetails`).toBe(r.chargingDetails);
    }
  });

  it("dedupes identifiers that appear on multiple roads", async () => {
    const got = await runMigrated();
    const ids = got.map((f) => f.id);
    // A1-RAST-001 shows up in both A1 and A7 fixtures; only the first survives.
    expect(ids.filter((id) => id === "de-autobahn:A1-RAST-001")).toHaveLength(1);
  });

  it("filters out future-only and bad-coordinate entries", async () => {
    const got = await runMigrated();
    const ids = got.map((f) => f.id);
    expect(ids).not.toContain("de-autobahn:A1-FUTURE");
  });
});
