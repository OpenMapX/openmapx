import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it } from "vitest";
import { parseDeBnetzaCsv } from "../de-bnetza-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "bnetza-sample.csv"));

function collect(): PoiRow[] {
  return Array.from(parseDeBnetzaCsv(FIXTURE));
}

describe("parseDeBnetzaCsv", () => {
  it("skips rows with missing coordinates and yields the rest", () => {
    const rows = collect();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId)).toEqual(["LE-1001", "LE-1002"]);
  });

  it("emits bare poiId without the de-bnetza: prefix", () => {
    const rows = collect();
    for (const row of rows) {
      expect(row.poiId.startsWith("de-bnetza:")).toBe(false);
    }
  });

  it("decodes windows-1252 German characters in payload fields", () => {
    const munich = collect().find((r) => r.poiId === "LE-1002");
    expect(munich).toBeDefined();
    const address = (munich?.payload.address as Record<string, unknown>) ?? {};
    expect(address.town).toBe("München");
    expect(munich?.payload.operator).toEqual({ name: "Stadtwerke München" });
  });

  it("decodes a UTF-8-with-BOM register (BNetzA switched from windows-1252)", () => {
    const csv = Buffer.from(
      `﻿Ladeeinrichtungs-ID;Breitengrad;Längengrad\nLE-9001;52,52;13,377\n`,
      "utf-8",
    );
    const rows = Array.from(parseDeBnetzaCsv(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0].poiId).toBe("LE-9001");
    expect(rows[0].lat).toBeCloseTo(52.52);
    expect(rows[0].lng).toBeCloseTo(13.377);
  });

  it("parses coordinates into top-level lng/lat and duplicates into payload.coordinates", () => {
    const berlin = collect().find((r) => r.poiId === "LE-1001");
    expect(berlin?.lat).toBeCloseTo(52.52);
    expect(berlin?.lng).toBeCloseTo(13.377);
    expect(berlin?.payload.coordinates).toEqual([berlin?.lng, berlin?.lat]);
  });

  it("collects connectors across all Steckertypen columns", () => {
    const berlin = collect().find((r) => r.poiId === "LE-1001");
    const connectors = berlin?.payload.connectors as Array<Record<string, unknown>>;
    expect(connectors).toHaveLength(2);
    expect(connectors[0].type).toBe("Type 2");
    expect(connectors[0].powerKw).toBe(22);
    expect(connectors[1].type).toBe("CCS");
    expect(connectors[1].powerKw).toBe(150);
  });

  it("normalises 247 to 24/7 opening hours and maps Bezahlsysteme=Kostenlos to Free usageCost", () => {
    const berlin = collect().find((r) => r.poiId === "LE-1001");
    expect(berlin?.payload.openingHours).toBe("24/7");
    expect(berlin?.payload.usageCost).toBe("Free");
  });

  it("derives status text from German Status column", () => {
    const berlin = collect().find((r) => r.poiId === "LE-1001");
    expect(berlin?.payload.status).toBe("operational");
    const munich = collect().find((r) => r.poiId === "LE-1002");
    expect(munich?.payload.status).toBe("planned");
  });

  it("populates payload.name with displayName fallback chain", () => {
    const berlin = collect().find((r) => r.poiId === "LE-1001");
    expect(berlin?.payload.name).toBe("Charging Berlin Mitte");
  });
});
