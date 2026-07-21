import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGbEngUtmcStatic } from "../gb-eng-utmc-static-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "utmc-static-sample.json"));

describe("parseGbEngUtmcStatic", () => {
  it("yields one PoiRow per record with coordinates and skips empty definitions", () => {
    const rows = parseGbEngUtmcStatic(FIXTURE);
    expect(rows.map((r) => r.poiId)).toEqual(["CP1", "CP2"]);
  });

  it("emits bare poiId without the gb-eng-utmc: prefix", () => {
    const rows = parseGbEngUtmcStatic(FIXTURE);
    for (const row of rows) {
      expect(row.poiId.startsWith("gb-eng-utmc:")).toBe(false);
    }
  });

  it("parses lat/lng into top-level fields and duplicates into payload.coordinates", () => {
    const cp1 = parseGbEngUtmcStatic(FIXTURE).find((r) => r.poiId === "CP1");
    expect(cp1?.lat).toBeCloseTo(54.9755208253257, 10);
    expect(cp1?.lng).toBeCloseTo(-1.62522866852692, 10);
    expect(cp1?.payload.coordinates).toEqual([cp1?.lng, cp1?.lat]);
  });

  it("populates static-only fields and omits dynamic fields", () => {
    const cp1 = parseGbEngUtmcStatic(FIXTURE).find((r) => r.poiId === "CP1");
    expect(cp1?.payload).toMatchObject({
      name: "Town Centre",
      capacity: 200,
      address: "Car park in Newcastle Town Centre",
      parkingType: "garage",
      fee: "unknown",
      staticDataUpdatedAt: "2012-01-13T12:19:32.419+0000",
    });
    expect(cp1?.payload).not.toHaveProperty("freeSpaces");
    expect(cp1?.payload).not.toHaveProperty("state");
    expect(cp1?.payload).not.toHaveProperty("hasRealtimeData");
    expect(cp1?.payload).not.toHaveProperty("realtimeDataUpdatedAt");
  });

  it("falls back to 'Car Park <id>' name when shortDescription is missing", () => {
    const buffer = Buffer.from(
      JSON.stringify([
        {
          systemCodeNumber: "CPX",
          definitions: [{ point: { latitude: 55, longitude: -1.5 } }],
          configurations: [],
        },
      ]),
    );
    const rows = parseGbEngUtmcStatic(buffer);
    expect(rows[0]?.payload.name).toBe("Car Park CPX");
  });

  it("returns [] for non-JSON or non-array input", () => {
    expect(parseGbEngUtmcStatic(Buffer.from("not json"))).toEqual([]);
    expect(parseGbEngUtmcStatic(Buffer.from(JSON.stringify({ not: "array" })))).toEqual([]);
  });
});
