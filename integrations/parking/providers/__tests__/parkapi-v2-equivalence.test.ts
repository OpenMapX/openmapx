import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParkApiV2City,
  ParkApiV2Lot,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeParkApiV2BundledParser } from "../parkapi-v2-bundled-parser.js";
import { mapParkApiV2Payload, mergeParkApiV2Live } from "../parkapi-v2-mapper.js";

const CITIES_FIXTURE = readFileSync(join(__dirname, "fixtures", "parkapi-v2-cities.json"));
const DRESDEN_LOTS = readFileSync(join(__dirname, "fixtures", "parkapi-v2-dresden.json"));
const MUNICH_LOTS = readFileSync(join(__dirname, "fixtures", "parkapi-v2-munich.json"));

const CITIES_PARSED = JSON.parse(CITIES_FIXTURE.toString("utf-8")) as {
  cities: Record<string, ParkApiV2City>;
};
const DRESDEN_PARSED = JSON.parse(DRESDEN_LOTS.toString("utf-8")) as { lots: ParkApiV2Lot[] };
const MUNICH_PARSED = JSON.parse(MUNICH_LOTS.toString("utf-8")) as { lots: ParkApiV2Lot[] };

/**
 * Pre-migration reference, lifted from the prior `parkapi-v2.ts` `lotToFacility`.
 * We compare against the migrated parse → map → merge pipeline output, omitting
 * the two new realtime-timestamp fields (`dataUpdatedAt`/`realtimeDataUpdatedAt`)
 * that didn't exist in the legacy mapper.
 */

const LOT_TYPE_MAP: Record<string, ParkingType> = {
  Tiefgarage: "underground",
  Parkhaus: "garage",
  Parkplatz: "surface",
};
function refMapLotType(lotType?: string): ParkingType {
  if (!lotType) return "unknown";
  return LOT_TYPE_MAP[lotType] ?? "unknown";
}
function refMapState(state?: string): "open" | "closed" | "unknown" {
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return "unknown";
}
function refLotToFacility(lot: ParkApiV2Lot, cityName: string): ParkingFacility | null {
  if (!lot.coords) return null;
  const hasRealtime = lot.free !== undefined && lot.free !== null;
  return {
    id: `parkapi-v2:${cityName}/${lot.id}`,
    name: lot.name,
    coordinates: [lot.coords.lng, lot.coords.lat],
    sources: [`parkapi-v2/${cityName}`],
    parkingType: refMapLotType(lot.lot_type),
    capacity: lot.total ?? undefined,
    freeSpaces: hasRealtime ? lot.free : undefined,
    hasRealtimeData: hasRealtime,
    state: refMapState(lot.state),
    address: lot.address ?? undefined,
  };
}

function runReference(): ParkingFacility[] {
  const out: ParkingFacility[] = [];
  // Reference iterates cities the same way the catalog parser did:
  // skip cities without coords or without active_support.
  for (const [name, city] of Object.entries(CITIES_PARSED.cities)) {
    if (!city.coords) continue;
    if (!city.active_support) continue;
    const lotsForCity =
      name === "Dresden" ? DRESDEN_PARSED.lots : name === "Munich" ? MUNICH_PARSED.lots : [];
    for (const lot of lotsForCity) {
      const f = refLotToFacility(lot, name);
      if (f) out.push(f);
    }
  }
  return out;
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const API_BASE = "https://api.parkendd.de";

function makeFetchMock() {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === `${API_BASE}/Dresden`) {
      return new Response(DRESDEN_LOTS.toString("utf-8"), { status: 200 });
    }
    if (url === `${API_BASE}/Munich`) {
      return new Response(MUNICH_LOTS.toString("utf-8"), { status: 200 });
    }
    if (url === `${API_BASE}/Berlin`) {
      throw new Error("Berlin should be filtered out by active_support=false");
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const parse = makeParkApiV2BundledParser();
  const { static: rows, live } = await parse(CITIES_FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapParkApiV2Payload(row.poiId, row.payload);
    const merged = mergeParkApiV2Live(base, live.get(row.poiId) ?? null);
    // Drop fields the pre-migration mapper didn't write so the comparison
    // stays strict on the fields it did write.
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parkapi-v2 parser+mapper equivalence to pre-migration impl", () => {
  it("produces field-by-field-identical facilities across federated cities", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

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
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.state, `row ${i}: state`).toBe(r.state);
      expect(g.address, `row ${i}: address`).toBe(r.address);
    }
  });

  it("respects active_support and skips lots without coords", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const got = await runMigrated();
    // Berlin should be excluded (active_support=false); 'no-coords' Dresden lot omitted.
    const ids = got.map((f) => f.id);
    expect(ids).toContain("parkapi-v2:Dresden/altmarkt");
    expect(ids).toContain("parkapi-v2:Dresden/centrum");
    expect(ids).toContain("parkapi-v2:Munich/marienplatz");
    expect(ids).toContain("parkapi-v2:Munich/olympiastadion");
    expect(ids).not.toContain("parkapi-v2:Dresden/no-coords");
  });

  it("falls back gracefully if a city endpoint errors out", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === `${API_BASE}/Dresden`) {
        return new Response(DRESDEN_LOTS.toString("utf-8"), { status: 200 });
      }
      if (url === `${API_BASE}/Munich`) {
        return new Response("oops", { status: 500 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const got = await runMigrated();
    // Dresden survives; Munich's 5xx degrades to zero lots.
    expect(got.some((f) => f.id.startsWith("parkapi-v2:Dresden/"))).toBe(true);
    expect(got.some((f) => f.id.startsWith("parkapi-v2:Munich/"))).toBe(false);
  });
});
