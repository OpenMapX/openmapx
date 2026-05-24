import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUtmcLive } from "../utmc-newcastle-live-parser.js";
import { mapUtmcPayload, mergeUtmcLive } from "../utmc-newcastle-mapper.js";
import { parseUtmcStatic } from "../utmc-newcastle-static-parser.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2012-01-14T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Pre-migration reference implementation, lifted verbatim from the prior
 * `integrations/parking/providers/utmc-newcastle.ts` as it stood before the
 * POI-ingest migration. Source ids are unchanged (`utmc-newcastle`,
 * `utmc:` prefix), so the equivalence must be field-by-field exact — no
 * id remap required.
 */

interface UtmcStaticCarParkRef {
  systemCodeNumber: string;
  definitions: Array<{
    shortDescription?: string;
    longDescription?: string;
    point?: { latitude?: number; longitude?: number };
    lastUpdated?: string;
  }>;
  configurations: Array<{ capacity?: number }>;
}
interface UtmcDynamicCarParkRef {
  systemCodeNumber: string;
  dynamics: Array<{
    occupancy?: number;
    stateDescription?: string;
    lastUpdated?: string;
  }>;
}

function refMapState(stateDescription?: string): "open" | "closed" | "unknown" {
  if (!stateDescription) return "unknown";
  const upper = stateDescription.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "FAULTY") return "closed";
  if (upper === "SPACES" || upper === "ALMOST FULL" || upper === "FULL" || upper === "OPEN") {
    return "open";
  }
  return "unknown";
}

function refDeriveFreeSpaces(
  occupancy: number | undefined,
  capacity: number | undefined,
): number | undefined {
  if (occupancy == null || capacity == null) return undefined;
  const free = capacity - occupancy;
  return free >= 0 ? free : 0;
}

// Mirrors the shared isLiveTooStale helper so the reference impl reproduces
// the post-migration "stale live ⇒ hasRealtimeData=false" behaviour. The
// merger uses UTMC's 15-minute threshold.
const UTMC_MAX_LIVE_AGE_MS = 15 * 60 * 1000;

function refIsLiveTooStale(asOf: string | undefined, maxAgeMs: number, now: number): boolean {
  if (!asOf) return false;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeMs;
}

function refStaticToFacility(
  record: UtmcStaticCarParkRef,
  dynamic: UtmcDynamicCarParkRef | undefined,
  now: number,
): ParkingFacility | null {
  const def = record.definitions?.[0];
  const cfg = record.configurations?.[0];
  if (!def) return null;
  const lat = def.point?.latitude;
  const lng = def.point?.longitude;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const capacity = cfg?.capacity;
  const dyn = dynamic?.dynamics?.[0];
  const occupancy = dyn?.occupancy;
  const freeSpaces = refDeriveFreeSpaces(occupancy, capacity);
  const hasDynamic = dyn != null;
  const stale = hasDynamic ? refIsLiveTooStale(dyn?.lastUpdated, UTMC_MAX_LIVE_AGE_MS, now) : false;

  return {
    id: `utmc:${record.systemCodeNumber}`,
    name: def.shortDescription || `Car Park ${record.systemCodeNumber}`,
    coordinates: [lng, lat],
    sources: ["utmc-newcastle"],
    parkingType: "garage" as ParkingType,
    capacity: capacity != null && capacity > 0 ? capacity : undefined,
    freeSpaces,
    hasRealtimeData: hasDynamic && !stale,
    dataUpdatedAt: dyn?.lastUpdated ?? def.lastUpdated,
    staticDataUpdatedAt: def.lastUpdated,
    realtimeDataUpdatedAt: hasDynamic ? dyn?.lastUpdated : undefined,
    fee: "unknown",
    address: def.longDescription ?? undefined,
    state: hasDynamic ? refMapState(dyn?.stateDescription) : "unknown",
  };
}

const STATIC = readFileSync(join(__dirname, "fixtures", "utmc-static-sample.json"));
const DYNAMIC = readFileSync(join(__dirname, "fixtures", "utmc-dynamic-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function runReference(): ParkingFacility[] {
  const now = Date.now();
  const statics = JSON.parse(STATIC.toString("utf-8")) as UtmcStaticCarParkRef[];
  const dyns = JSON.parse(DYNAMIC.toString("utf-8")) as UtmcDynamicCarParkRef[];
  const dynMap = new Map<string, UtmcDynamicCarParkRef>();
  for (const d of dyns) {
    if (d?.systemCodeNumber) dynMap.set(d.systemCodeNumber, d);
  }
  const out: ParkingFacility[] = [];
  for (const r of statics) {
    if (!r?.definitions?.length) continue;
    const facility = refStaticToFacility(r, dynMap.get(r.systemCodeNumber), now);
    if (facility) out.push(facility);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const rows = parseUtmcStatic(STATIC);
  const liveMap = await parseUtmcLive(DYNAMIC, { log: noopLog });
  return rows.map((row) => {
    const base = mapUtmcPayload(row.poiId, row.payload);
    const live = liveMap.get(row.poiId) ?? null;
    return mergeUtmcLive(base, live);
  });
}

describe("utmc parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces the same set of facility ids", async () => {
    const reference = runReference();
    const migrated = await runMigrated();
    expect(migrated.map((f) => f.id)).toEqual(reference.map((f) => f.id));
  });

  it("produces field-by-field-identical facilities for every record", async () => {
    const reference = runReference();
    const migrated = await runMigrated();
    expect(migrated).toHaveLength(reference.length);
    for (let i = 0; i < reference.length; i++) {
      const ref = reference[i];
      const got = migrated[i];
      expect(got.id, `row ${i}: id`).toBe(ref.id);
      expect(got.name, `row ${i}: name`).toBe(ref.name);
      expect(got.coordinates, `row ${i}: coordinates`).toEqual(ref.coordinates);
      expect(got.sources, `row ${i}: sources`).toEqual(ref.sources);
      expect(got.parkingType, `row ${i}: parkingType`).toBe(ref.parkingType);
      expect(got.capacity, `row ${i}: capacity`).toBe(ref.capacity);
      expect(got.freeSpaces, `row ${i}: freeSpaces`).toBe(ref.freeSpaces);
      expect(got.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(ref.hasRealtimeData);
      expect(got.dataUpdatedAt, `row ${i}: dataUpdatedAt`).toBe(ref.dataUpdatedAt);
      expect(got.staticDataUpdatedAt, `row ${i}: staticDataUpdatedAt`).toBe(
        ref.staticDataUpdatedAt,
      );
      expect(got.realtimeDataUpdatedAt, `row ${i}: realtimeDataUpdatedAt`).toBe(
        ref.realtimeDataUpdatedAt,
      );
      expect(got.fee, `row ${i}: fee`).toBe(ref.fee);
      expect(got.address, `row ${i}: address`).toBe(ref.address);
      expect(got.state, `row ${i}: state`).toBe(ref.state);
    }
  });
});
