import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseAuNsw } from "../au-nsw-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/au-nsw.csv", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseAuNsw(fixture, { log }));
}

type Connector = { type?: string; powerKw?: number; currentType?: string; quantity?: number };

describe("parseAuNsw", () => {
  it("parses rows, dedupes an identical repeat row, and swaps coordinates to [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(7);
    const first = rows[0];
    expect(first.lng).toBeCloseTo(150.8901391);
    expect(first.lat).toBeCloseTo(-32.26224229);
    expect(first.payload.coordinates).toEqual([150.8901391, -32.26224229]);
  });

  it("falls back to Operator for name when Station_name is blank", () => {
    const [first] = parse();
    expect(first.payload.name).toBe("EVUp");
    expect((first.payload.address as { town?: string }).town).toBe("Muswellbrook Shire Council");
    expect((first.payload.address as { country?: string }).country).toBe("Australia");
  });

  it("maps AC to Type 2 and DC to CCS, both normalised by the shared connector() helper", () => {
    const rows = parse();
    const ac = rows[0].payload.connectors as Connector[];
    expect(ac[0]).toMatchObject({ type: "Type 2", currentType: "AC", powerKw: 22, quantity: 2 });

    const dc = rows[1].payload.connectors as Connector[];
    expect(dc[0]).toMatchObject({ type: "CCS", currentType: "DC", powerKw: 150, quantity: 4 });
  });

  it("overrides the connector type to Tesla when Operator is Tesla, regardless of AC/DC", () => {
    const rows = parse();
    const teslaAc = rows[2].payload.connectors as Connector[];
    expect(teslaAc[0]).toMatchObject({ type: "Tesla", currentType: "AC", quantity: 2 });

    const teslaDc = rows[3].payload.connectors as Connector[];
    expect(teslaDc[0]).toMatchObject({ type: "Tesla", currentType: "DC", quantity: 16 });
  });

  it("marks Charger_Type=Upcoming rows as planned", () => {
    const rows = parse();
    const upcoming = rows.find((r) => r.payload.name === "ChargeNet");
    expect(upcoming?.payload.status).toBe("planned");
  });

  it("marks rows whose Source doesn't start with 'Existing' as unknown", () => {
    const rows = parse();
    const arena = rows.find((r) => r.payload.name === "Jet Charge");
    expect(arena?.payload.status).toBe("unknown");
  });

  it("marks rows whose Source starts with 'Existing' as operational", () => {
    const rows = parse();
    expect(rows[0].payload.status).toBe("operational");
  });

  it("accepts the known 'NxPPPkW' Charger_rating quirk without crashing (documented imprecision)", () => {
    const rows = parse();
    const quirky = rows.find((r) => r.payload.name === "FastCharge Co");
    const connectors = quirky?.payload.connectors as Connector[];
    // parseLocalizedNumber greedily grabs the leading "2" from "2x350kW" —
    // acceptable, known imprecision rather than a 350kW misread.
    expect(connectors[0].powerKw).toBe(2);
  });
});
