import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParkingFacility,
  ParkingSourceAttribution,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import type { DatexParkingStatus } from "@openmapx/mobility-formats";
import { parseDatexParkingStatus, parseDatexParkingTable } from "@openmapx/mobility-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCitaLuBundled } from "../cita-lu-bundled-parser.js";
import { mapCitaLuPayload, mergeCitaLuLive } from "../cita-lu-mapper.js";

/**
 * Pre-migration reference, lifted from the prior `cita-lu.ts` →
 * `datex-parking-provider.ts` factory invocation. The factory wrapped
 * `parseDatexParkingTable` + `parseDatexParkingStatus` and called
 * `recordToFacility` per row, which is what we replicate here.
 *
 * Source id (`cita-lu`) and prefix (`cita-lu:`) unchanged. The fixture covers
 * a record with `freeOfCharge=false` + status `open` (P/1), a `full` site
 * (P-2), and a record with no status entry (P3).
 */

const TABLE_FIXTURE = readFileSync(join(__dirname, "fixtures", "cita-lu-table.xml"));
const STATUS_FIXTURE = readFileSync(join(__dirname, "fixtures", "cita-lu-status.xml"));
const STATUS_URL = "https://www.cita.lu/info_trafic/datex/parking_dynamic.xml";

const REF_ATTRIBUTION: ParkingSourceAttribution = {
  name: "CITA Luxembourg",
  url: "https://www.cita.lu/",
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};
const REF_STALE_AFTER_MS = 30 * 60 * 1000;

function refStatusToState(status: DatexParkingStatus | undefined): ParkingFacility["state"] {
  const normalized = status?.siteStatus?.toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("closed")) return "closed";
  if (
    normalized.includes("open") ||
    normalized.includes("available") ||
    normalized.includes("full")
  ) {
    return "open";
  }
  return "unknown";
}

function refIsStale(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return now - time > REF_STALE_AFTER_MS;
}

function runReference(now: number): ParkingFacility[] {
  const records = parseDatexParkingTable(TABLE_FIXTURE.toString("utf-8"));
  const statuses = parseDatexParkingStatus(STATUS_FIXTURE.toString("utf-8"));
  const statusMap = new Map(statuses.map((s) => [s.recordId, s]));

  const out: ParkingFacility[] = [];
  for (const record of records) {
    const status = statusMap.get(record.id);
    const warnings: string[] = [];
    const capacity =
      record.totalSpaces ??
      (status?.vacantSpaces !== undefined && status?.occupiedSpaces !== undefined
        ? status.vacantSpaces + status.occupiedSpaces
        : undefined);
    let freeSpaces = status?.vacantSpaces;
    if (freeSpaces !== undefined && freeSpaces < 0) {
      warnings.push("Realtime free-space count was negative and was clamped to 0.");
      freeSpaces = 0;
    }
    if (freeSpaces !== undefined && capacity !== undefined && freeSpaces > capacity) {
      warnings.push("Realtime free-space count exceeded capacity and was clamped.");
      freeSpaces = capacity;
    }
    const isStale = refIsStale(status?.originTime, now);
    if (isStale) warnings.push("Realtime availability is older than 30 minutes.");

    out.push({
      id: `cita-lu:${encodeURIComponent(record.id)}`,
      name: record.name,
      coordinates: [record.longitude, record.latitude],
      sources: ["cita-lu"],
      sourceUid: record.id,
      sourceName: "CITA Luxembourg",
      sourceUrl: "https://www.cita.lu/",
      sourceAttribution: REF_ATTRIBUTION,
      parkingType: "surface" as ParkingType,
      capacity,
      freeSpaces,
      hasRealtimeData: freeSpaces !== undefined,
      dataUpdatedAt: status?.originTime,
      realtimeDataUpdatedAt: status?.originTime,
      isStale: isStale || undefined,
      qualityWarnings: warnings.length > 0 ? warnings : undefined,
      fee:
        record.freeOfCharge === true ? "free" : record.freeOfCharge === false ? "paid" : "unknown",
      state: refStatusToState(status),
    });
  }
  return out;
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function runMigrated(): Promise<ParkingFacility[]> {
  const { static: rows, live } = await parseCitaLuBundled(TABLE_FIXTURE, { log: noopLog });
  return rows.map((row) => {
    const base = mapCitaLuPayload(row.poiId, row.payload);
    return mergeCitaLuLive(base, live.get(row.poiId) ?? null);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cita-lu parser+mapper equivalence to pre-migration DATEX provider", () => {
  it("produces field-by-field-identical facilities", async () => {
    const FIXED_NOW = Date.parse("2026-05-23T11:10:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
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

    const ref = runReference(FIXED_NOW);
    const got = await runMigrated();

    expect(got).toHaveLength(ref.length);
    for (let i = 0; i < ref.length; i++) {
      const r = ref[i];
      const g = got[i];
      expect(g.id, `row ${i}: id`).toBe(r.id);
      expect(g.name, `row ${i}: name`).toBe(r.name);
      expect(g.coordinates, `row ${i}: coordinates`).toEqual(r.coordinates);
      expect(g.sources, `row ${i}: sources`).toEqual(r.sources);
      expect(g.sourceUid, `row ${i}: sourceUid`).toBe(r.sourceUid);
      expect(g.sourceName, `row ${i}: sourceName`).toBe(r.sourceName);
      expect(g.sourceUrl, `row ${i}: sourceUrl`).toBe(r.sourceUrl);
      expect(g.sourceAttribution, `row ${i}: sourceAttribution`).toEqual(r.sourceAttribution);
      expect(g.parkingType, `row ${i}: parkingType`).toBe(r.parkingType);
      expect(g.capacity, `row ${i}: capacity`).toBe(r.capacity);
      expect(g.freeSpaces, `row ${i}: freeSpaces`).toBe(r.freeSpaces);
      expect(g.hasRealtimeData, `row ${i}: hasRealtimeData`).toBe(r.hasRealtimeData);
      expect(g.dataUpdatedAt, `row ${i}: dataUpdatedAt`).toBe(r.dataUpdatedAt);
      expect(g.realtimeDataUpdatedAt, `row ${i}: realtimeDataUpdatedAt`).toBe(
        r.realtimeDataUpdatedAt,
      );
      expect(g.isStale, `row ${i}: isStale`).toBe(r.isStale);
      expect(g.qualityWarnings, `row ${i}: qualityWarnings`).toEqual(r.qualityWarnings);
      expect(g.fee, `row ${i}: fee`).toBe(r.fee);
      expect(g.state, `row ${i}: state`).toBe(r.state);
    }
  });

  it("URL-encodes record ids with slashes into the stable poiId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(STATUS_FIXTURE.toString("utf-8"), { status: 200 })),
    );
    const got = await runMigrated();
    const ids = got.map((f) => f.id);
    expect(ids).toContain("cita-lu:P%2F1");
    expect(ids).toContain("cita-lu:P-2");
    expect(ids).toContain("cita-lu:P3");
  });
});
