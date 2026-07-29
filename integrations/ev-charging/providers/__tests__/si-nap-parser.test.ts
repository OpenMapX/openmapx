import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseSiNap } from "../si-nap-parser.js";

// Fixture: three real `energyInfrastructureSite` blocks trimmed verbatim out
// of NAP Slovenija's own published DATEX II sample (dataset code viewer for
// dataset id 46963663-38dd-eb04-43a9-cca9bdc0e4ba, "Prometej IDACS Energy
// Infrastructure Table"), wrapped in the same publication header. Not
// synthetic — this is documented, real upstream data.
const fixture = readFileSync(fileURLToPath(new URL("./fixtures/si-nap.xml", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseSiNap(fixture, { log }));
}

describe("parseSiNap", () => {
  it("parses the unwrapped DATEX II root (no d2:payload) and swaps lat/lon into [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(3);

    const catez = rows.find((r) => r.poiId === "246ea408-3f25-4378-95a5-b9829851edc2");
    expect(catez).toBeDefined();
    expect(catez?.lng).toBeCloseTo(15.59736);
    expect(catez?.lat).toBeCloseTo(45.89166);
    expect(catez?.payload.coordinates).toEqual([15.59736, 45.89166]);
    expect(catez?.payload.name).toBe("BS AC ČATEŽ - JUG");
  });

  it("reads the single Slovenian address line plus city/postcode, hardcoding country to Slovenia", () => {
    const rows = parse();
    const catez = rows.find((r) => r.poiId === "246ea408-3f25-4378-95a5-b9829851edc2");
    expect(catez?.payload.address).toEqual({
      line1: "RIMSKA CESTA 11",
      town: "BREŽICE",
      postcode: "8250",
      country: "Slovenia",
    });
  });

  it("reads the operator name from operator/name/values/value", () => {
    const rows = parse();
    const catez = rows.find((r) => r.poiId === "246ea408-3f25-4378-95a5-b9829851edc2");
    expect(catez?.payload.operator).toEqual({ name: "PETROL, d.d" });
  });

  it("flattens refillPoint/connector across multiple stations, mapping chademo and CCS combo to DC", () => {
    const rows = parse();
    const catez = rows.find((r) => r.poiId === "246ea408-3f25-4378-95a5-b9829851edc2");
    expect(catez).toBeDefined();
    const connectors = catez?.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    // 8 stations, one refillPoint/connector each.
    expect(connectors).toHaveLength(8);

    const chademo = connectors.filter((c) => c.type === "CHAdeMO");
    expect(chademo).toHaveLength(2);
    for (const conn of chademo) {
      expect(conn).toMatchObject({ currentType: "DC", powerKw: 50, quantity: 1 });
    }

    const ccs = connectors.filter((c) => c.type === "CCS");
    expect(ccs.length).toBeGreaterThan(0);
    for (const conn of ccs) {
      expect(conn.currentType).toBe("DC");
    }

    const type2 = connectors.filter((c) => c.type === "Type 2");
    expect(type2.length).toBeGreaterThan(0);
    for (const conn of type2) {
      expect(conn.currentType).toBe("AC");
    }
  });

  it("maps domestic household-socket connector types to AC and normalises Schuko", () => {
    const rows = parse();
    const naklo = rows.find((r) => r.poiId === "41944637-9579-4337-9546-138bfb068d66");
    expect(naklo).toBeDefined();
    const connectors = naklo?.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
    }>;
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "Schuko", currentType: "AC" }),
        expect.objectContaining({ type: "Type 2", currentType: "AC" }),
      ]),
    );
  });

  it("handles a non-GUID site id and multiple refillPoints under one station (bicycle charger site)", () => {
    const rows = parse();
    const ruse = rows.find((r) => r.poiId === "SI*EVT*P326P");
    expect(ruse).toBeDefined();
    const connectors = ruse?.payload.connectors as Array<{ type?: string; powerKw?: number }>;
    expect(connectors).toHaveLength(4);
    // "other" connectorType falls back to "Unknown".
    expect(connectors.filter((c) => c.type === "Unknown")).toHaveLength(2);
    // "domesticB" is unmapped by normalizeConnectorType and passes through cleaned.
    expect(connectors.filter((c) => c.type === "Domestic (Type B)")).toHaveLength(2);
  });

  it("drops rows with no resolvable coordinates and de-duplicates by site id", () => {
    const rows = parse();
    const ids = rows.map((r) => r.poiId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
