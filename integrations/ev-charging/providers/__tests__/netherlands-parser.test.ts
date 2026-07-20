import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapNetherlandsPayload } from "../netherlands-mapper.js";
import { parseDotNl } from "../netherlands-parser.js";

const LOCATIONS_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "netherlands-locations-sample.json"),
);
const TARIFFS_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "netherlands-tariffs-sample.json"),
);

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function installTariffsFetchStub(): void {
  // The tariffs feed is a bare gzip body — the parser must gunzip it itself
  // (see netherlands-parser.ts). Stub a real gzip response so that path is
  // exercised rather than mocked away.
  const gzipped = gzipSync(TARIFFS_FIXTURE);
  const fakeFetch = vi.fn(async () => new Response(new Uint8Array(gzipped), { status: 200 }));
  vi.stubGlobal("fetch", fakeFetch);
}

async function collectRows(): Promise<PoiRow[]> {
  const rows: PoiRow[] = [];
  for await (const row of parseDotNl(LOCATIONS_FIXTURE, { log: noopLog })) {
    rows.push(row);
  }
  return rows;
}

describe("parseDotNl", () => {
  beforeEach(() => {
    installTariffsFetchStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("yields one row per valid location and drops rows with unparsable coordinates", async () => {
    const rows = await collectRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.poiId)).toEqual([
      encodeURIComponent("ca701e7f-71a7-49bf-bfff-a47c4c801819"),
      encodeURIComponent("62b5a5c75e1ba10d8eb4757c"),
      encodeURIComponent("no-tariff-station"),
    ]);
  });

  it("emits bare encoded poiId without the nl-dotnl: prefix", async () => {
    const rows = await collectRows();
    for (const row of rows) {
      expect(row.poiId.startsWith("nl-dotnl:")).toBe(false);
    }
  });

  it("parses string coordinates into [lng, lat] and drops the NaN-coordinate location", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.coordinates).toEqual([5.009343, 52.3505]);
    expect(rows.some((r) => r.poiId === encodeURIComponent("missing-coords-station"))).toBe(false);
  });

  it("computes connector powerKw in kW from watts, rounded to 1 decimal", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.connectors.map((c) => c.powerKw)).toEqual([22.1, 50, 50]);
  });

  it("maps power_type to AC/DC currentType", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.connectors.map((c) => c.currentType)).toEqual(["AC", "DC", "DC"]);
  });

  it("maps OCPI connector standard to human-readable, normalized labels", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    // IEC_62196_T2_COMBO is routed through the shared connector()/
    // normalizeConnectorType() helper, so it collapses to the canonical
    // "CCS" label used by every other source (matches dedup.ts merging).
    expect(station.connectors.map((c) => c.type)).toEqual(["Type 2", "CCS", "CHAdeMO"]);
  });

  it("prefixes the mapped station id with nl-dotnl: and sets status unknown", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.id).toBe(`nl-dotnl:${rows[0].poiId}`);
    expect(station.status).toBe("unknown");
  });

  it("maps address fields from the OCPI location", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.address).toEqual({
      line1: "113 Ben Meerendonkstraat",
      town: "Amsterdam",
      postcode: "1087 LB",
      country: "NL",
    });
  });

  it("attaches tariffs resolved from the station's connector tariff_ids", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[0].poiId, rows[0].payload);
    expect(station.tariffs).toHaveLength(1);
    expect(station.tariffs?.[0].elements.map((e) => e.type)).toEqual(["flat", "time", "energy"]);
  });

  it("attaches the same shared tariff to a second station referencing the same tariff_id", async () => {
    const rows = await collectRows();
    // Second location's single connector shares the same tariff id as the
    // first — verify that resolution happens per-station, not globally.
    const station = mapNetherlandsPayload(rows[1].poiId, rows[1].payload);
    expect(station.tariffs).toHaveLength(1);
    expect(station.tariffs?.[0].elements.map((e) => e.type)).toEqual(["flat", "time", "energy"]);
  });

  it("leaves tariffs undefined for a station whose connectors carry no tariff_ids", async () => {
    const rows = await collectRows();
    const station = mapNetherlandsPayload(rows[2].poiId, rows[2].payload);
    expect(station.tariffs).toBeUndefined();
  });
});
