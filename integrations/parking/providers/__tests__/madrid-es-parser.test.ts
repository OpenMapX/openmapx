import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMadridEsStatic } from "../madrid-es-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "madrid-es-sample.json"));

describe("parseMadridEsStatic", () => {
  it("skips entries without location and yields the rest", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.map((r) => r.poiId)).toEqual(["1", "2", "3"]);
  });

  it("fixes the double-negative longitude JSON bug", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    const r1 = rows.find((r) => r.poiId === "1");
    const r3 = rows.find((r) => r.poiId === "3");
    expect(r1?.lng).toBeCloseTo(-3.7074);
    expect(r3?.lng).toBeCloseTo(-3.7501);
  });

  it("parses capacity from 'Plazas:' and sums 'X públicas y Y residentes'", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.find((r) => r.poiId === "1")?.payload.capacity).toBe(463);
    expect(rows.find((r) => r.poiId === "2")?.payload.capacity).toBe(654);
    expect(rows.find((r) => r.poiId === "3")?.payload.capacity).toBe(344);
  });

  it("extracts disabledSpaces from 'N minusválidos'", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.find((r) => r.poiId === "1")?.payload.disabledSpaces).toBe(17);
    expect(rows.find((r) => r.poiId === "2")?.payload.disabledSpaces).toBeUndefined();
  });

  it("infers parkingType from title keywords", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.find((r) => r.poiId === "1")?.payload.parkingType).toBe("underground");
    expect(rows.find((r) => r.poiId === "2")?.payload.parkingType).toBe("surface");
    expect(rows.find((r) => r.poiId === "3")?.payload.parkingType).toBe("garage");
  });

  it("flags parkAndRide for 'disuasorio' / 'p+r' titles", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.find((r) => r.poiId === "2")?.payload.parkAndRide).toBe(true);
    expect(rows.find((r) => r.poiId === "3")?.payload.parkAndRide).toBe(true);
    expect(rows.find((r) => r.poiId === "1")?.payload.parkAndRide).toBeUndefined();
  });

  it("formats address from street + postal-code + locality", () => {
    const rows = parseMadridEsStatic(FIXTURE);
    expect(rows.find((r) => r.poiId === "1")?.payload.address).toBe("Plaza Mayor 27, 28012 Madrid");
  });

  it("returns [] for non-JSON or missing @graph", () => {
    expect(parseMadridEsStatic(Buffer.from("not json"))).toEqual([]);
    expect(parseMadridEsStatic(Buffer.from(JSON.stringify({})))).toEqual([]);
  });
});
