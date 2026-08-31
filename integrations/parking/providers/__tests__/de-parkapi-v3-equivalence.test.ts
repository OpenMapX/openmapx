import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParkApiV3Site,
  ParkApiV3Source,
  ParkingFacility,
  ParkingType,
} from "@openmapx/mobility-core/parking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeParkapiV3BundledParser } from "../de-parkapi-v3-bundled-parser.js";
import { mapDeParkapiV3Payload, mergeDeParkapiV3Live } from "../de-parkapi-v3-mapper.js";
import {
  parkingEquivalenceContract,
  stubSuccessfulFetchResponse,
} from "./support/parking-equivalence-contract.js";

const FIXTURE_PATH = join(__dirname, "fixtures", "parkapi-v3-sample.json");
const FIXTURE_BUFFER = readFileSync(FIXTURE_PATH);
const FIXTURE_PARSED = JSON.parse(FIXTURE_BUFFER.toString("utf-8")) as {
  items: ParkApiV3Site[];
};

const SOURCES_API = "https://api.mobidata-bw.de/park-api/api/public/v3/sources";
const FIXED_NOW = Date.parse("2026-05-06T12:00:00.000Z");

const SOURCES_RESPONSE: { items: ParkApiV3Source[] } = {
  items: [
    {
      uid: "bw",
      name: "MobiData BW",
      public_url: "https://mobidata-bw.de/",
      static_data_updated_at: "2026-05-06T07:00:00.000Z",
      realtime_data_updated_at: "2026-05-06T11:00:00.000Z",
      attribution_contributor: "MobiData BW",
      attribution_license: "dl-de/by-2-0",
      attribution_url: "https://www.govdata.de/dl-de/by-2-0",
    },
    {
      uid: "rail",
      name: "Rail parking source",
      public_url: "https://parking.example/",
      static_data_updated_at: null,
      realtime_data_updated_at: null,
    },
  ],
};

/**
 * Reference implementation — lifted verbatim from the pre-migration
 * `parkapi-v3.ts` `siteToFacility` function. Equivalence is checked field by
 * field for the fixture-emitted facilities (skipping non-CAR / missing-coord).
 */

const REALTIME_STALE_AFTER_MS = 30 * 60 * 1000;
const TYPE_MAP: Record<string, ParkingType> = {
  UNDERGROUND: "underground",
  CAR_PARK: "garage",
  OFF_STREET_PARKING_GROUND: "surface",
  ON_STREET: "on-street",
};

function refMapType(type?: string): ParkingType {
  if (!type) return "unknown";
  return TYPE_MAP[type] ?? "unknown";
}

function refIsStaleTimestamp(
  value: string | undefined,
  staleAfterMs: number,
  now: number,
): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return now - time > staleAfterMs;
}

function refNormalizeSourceAttribution(source: ParkApiV3Source | undefined) {
  if (!source) return undefined;
  const license = source.attribution_license?.trim() || undefined;
  const contributor = source.attribution_contributor?.trim() || undefined;
  const url = source.attribution_url?.trim() || undefined;
  return {
    contributor,
    license,
    licenseUrl: url,
    name: contributor || source.name,
    url: source.public_url ?? undefined,
  };
}

function refNormalizeRealtime(site: ParkApiV3Site): {
  capacity?: number;
  freeSpaces?: number;
  hasRealtime: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const capacity =
    site.capacity ??
    (typeof site.realtime_capacity === "number" ? site.realtime_capacity : undefined);
  const rawFree =
    typeof site.realtime_free_capacity === "number" ? site.realtime_free_capacity : undefined;
  const hasRealtime = site.has_realtime_data === true && rawFree !== undefined;
  if (!hasRealtime) return { capacity, hasRealtime: false, warnings };

  let freeSpaces = rawFree;
  if (freeSpaces < 0) {
    warnings.push("Realtime free-space count was negative and was clamped to 0.");
    freeSpaces = 0;
  }
  if (capacity !== undefined && freeSpaces > capacity) {
    warnings.push("Realtime free-space count exceeded capacity and was clamped.");
    freeSpaces = capacity;
  }
  return { capacity, freeSpaces, hasRealtime, warnings };
}

function refSiteToFacility(
  site: ParkApiV3Site,
  source: ParkApiV3Source | undefined,
  now: number,
): ParkingFacility | null {
  if (site.purpose && site.purpose !== "CAR") return null;
  const lat = site.lat != null ? Number.parseFloat(site.lat) : undefined;
  const lon = site.lon != null ? Number.parseFloat(site.lon) : undefined;
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;

  const realtime = refNormalizeRealtime(site);
  const staticDataUpdatedAt =
    site.static_data_updated_at ?? source?.static_data_updated_at ?? undefined;
  const realtimeDataUpdatedAt =
    site.realtime_data_updated_at ?? source?.realtime_data_updated_at ?? undefined;
  const dataUpdatedAt =
    realtime.hasRealtime && realtimeDataUpdatedAt ? realtimeDataUpdatedAt : staticDataUpdatedAt;
  const isStale =
    realtime.hasRealtime &&
    refIsStaleTimestamp(realtimeDataUpdatedAt, REALTIME_STALE_AFTER_MS, now);
  const qualityWarnings = [...realtime.warnings];
  if (isStale) qualityWarnings.push("Realtime availability is older than 30 minutes.");

  return {
    id: `de-parkapi-v3:${site.id}`,
    name: site.name,
    coordinates: [lon, lat],
    sources: ["de-parkapi-v3"],
    sourceUid: site.source_uid,
    sourceName: source?.name,
    sourceUrl: source?.public_url ?? undefined,
    sourceAttribution: refNormalizeSourceAttribution(source),
    parkingType: refMapType(site.type),
    capacity: realtime.capacity,
    freeSpaces: realtime.freeSpaces,
    // Post-migration: stale realtime flips hasRealtimeData=false so consumers
    // stop trusting cached freeSpaces/state. Pre-migration set this to true
    // unconditionally and surfaced staleness only via `isStale`/`qualityWarnings`.
    hasRealtimeData: realtime.hasRealtime && !isStale,
    dataUpdatedAt,
    staticDataUpdatedAt,
    realtimeDataUpdatedAt,
    isStale: isStale || undefined,
    qualityWarnings: qualityWarnings.length > 0 ? qualityWarnings : undefined,
    disabledSpaces: site.capacity_disabled ?? undefined,
    chargingSpaces: site.capacity_charging ?? undefined,
    maxHeight: site.max_height ?? undefined,
    fee: site.has_fee === true ? "paid" : site.has_fee === false ? "free" : "unknown",
    feeDescription: site.fee_description ?? undefined,
    operator: site.operator_name ?? undefined,
    address: site.address ?? undefined,
    openingHours: site.opening_hours ?? undefined,
    url: site.public_url ?? undefined,
  };
}

function runReference(now: number): ParkingFacility[] {
  const sources = new Map(SOURCES_RESPONSE.items.map((s) => [s.uid, s]));
  const out: ParkingFacility[] = [];
  for (const site of FIXTURE_PARSED.items) {
    const f = refSiteToFacility(
      site,
      site.source_uid ? sources.get(site.source_uid) : undefined,
      now,
    );
    if (f) out.push(f);
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
  const parse = makeDeParkapiV3BundledParser();
  const { static: rows, live } = await parse(FIXTURE_BUFFER, { log: noopLog });
  return rows.map((row) => {
    const base = mapDeParkapiV3Payload(row.poiId, row.payload);
    return mergeDeParkapiV3Live(base, live.get(row.poiId) ?? null);
  });
}

async function runMigratedWithSources(): Promise<ParkingFacility[]> {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  stubSuccessfulFetchResponse(SOURCES_API, JSON.stringify(SOURCES_RESPONSE));
  return runMigrated();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

parkingEquivalenceContract({
  name: "ParkAPI v3",
  reference: () => runReference(FIXED_NOW),
  migrated: runMigratedWithSources,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "sourceUid",
    "sourceName",
    "sourceUrl",
    "sourceAttribution",
    "parkingType",
    "capacity",
    "freeSpaces",
    "hasRealtimeData",
    "dataUpdatedAt",
    "staticDataUpdatedAt",
    "realtimeDataUpdatedAt",
    "isStale",
    "qualityWarnings",
    "disabledSpaces",
    "chargingSpaces",
    "maxHeight",
    "fee",
    "feeDescription",
    "operator",
    "address",
    "openingHours",
    "url",
  ],
});

describe("parkapi-v3 parser+mapper equivalence to pre-migration impl", () => {
  it("skips bike/missing-coord sites just like the pre-migration impl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(SOURCES_RESPONSE), { status: 200 })),
    );
    const got = await runMigrated();
    const ids = got.map((f) => f.id);
    expect(ids).not.toContain("de-parkapi-v3:2");
    expect(ids).not.toContain("de-parkapi-v3:5");
    expect(ids).toEqual(["de-parkapi-v3:1", "de-parkapi-v3:3", "de-parkapi-v3:4"]);
  });
});
