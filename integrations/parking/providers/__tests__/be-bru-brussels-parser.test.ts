import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBeBruBrusselsStatic } from "../be-bru-brussels-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "brussels-be-sample.json"));

describe("parseBeBruBrusselsStatic", () => {
  it("skips records without geo_point_2d", () => {
    const rows = parseBeBruBrusselsStatic(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId)).toEqual(["Parking 58", "Parking Albertine"]);
  });

  it("converts meters maxheight (<10) to centimeters and keeps cm values as-is", () => {
    const rows = parseBeBruBrusselsStatic(FIXTURE);
    const p58 = rows.find((r) => r.poiId === "Parking 58");
    const albert = rows.find((r) => r.poiId === "Parking Albertine");
    expect(p58?.payload.maxHeight).toBe(200);
    expect(albert?.payload.maxHeight).toBe(195);
  });

  it("populates name fallback chain (fr → nl → 'Parking') and address from adressee", () => {
    const rows = parseBeBruBrusselsStatic(FIXTURE);
    const p58 = rows.find((r) => r.poiId === "Parking 58");
    expect(p58?.payload.name).toBe("Parking 58");
    expect(p58?.payload.address).toBe("Rue de l'Évêque 1");
    expect(p58?.payload.operator).toBe("Interparking");
  });

  it("emits bare poiId without the be-bru-brussels: prefix and duplicates coordinates into payload", () => {
    const rows = parseBeBruBrusselsStatic(FIXTURE);
    for (const row of rows) {
      expect(row.poiId.startsWith("be-bru-brussels:")).toBe(false);
      expect(row.payload.coordinates).toEqual([row.lng, row.lat]);
    }
  });

  it("returns [] for non-JSON or non-array results", () => {
    expect(parseBeBruBrusselsStatic(Buffer.from("not json"))).toEqual([]);
    expect(parseBeBruBrusselsStatic(Buffer.from(JSON.stringify({ results: null })))).toEqual([]);
  });
});
