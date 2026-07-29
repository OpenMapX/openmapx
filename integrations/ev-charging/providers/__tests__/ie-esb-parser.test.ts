import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseIeEsb } from "../ie-esb-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/ie-esb.csv", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseIeEsb(fixture, { log }));
}

describe("parseIeEsb", () => {
  it("parses rows, strips the BOM, and swaps coordinates to [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(3);
    const fourLakes = rows[0];
    expect(fourLakes.lng).toBeCloseTo(-6.902268);
    expect(fourLakes.lat).toBeCloseTo(52.846593);
    expect(fourLakes.payload.coordinates).toEqual([-6.902268, 52.846593]);
    expect(fourLakes.payload.name).toBe("Four Lakes Retail Park");
  });

  it("builds one connector per non-zero Max. Sim. column with normalised types", () => {
    const [fourLakes] = parse();
    const connectors = fourLakes.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    expect(connectors).toHaveLength(3);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 50, quantity: 1 }),
        expect.objectContaining({ type: "CHAdeMO", currentType: "DC", powerKw: 50, quantity: 1 }),
        expect.objectContaining({ type: "Type 2", currentType: "AC", powerKw: 43, quantity: 1 }),
      ]),
    );
  });

  it("parses the '22(2)' power/quantity encoding for AC sockets", () => {
    const parade = parse()[1];
    const connectors = parade.payload.connectors as Array<{ powerKw?: number; quantity?: number }>;
    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toMatchObject({ powerKw: 22, quantity: 2 });
  });

  it("combines the price columns into a free-text usageCost with VAT", () => {
    const [fourLakes] = parse();
    expect(fourLakes.payload.usageCost).toBe("Fast: €0.57 /kWh; AC: €0.52 /kWh (VAT 9%)");
    expect(fourLakes.payload.openingHours).toBe("24/7");
    expect(fourLakes.payload.operator).toEqual({ name: "ESB ecars" });
    expect(fourLakes.payload.notes).toHaveLength(1);
  });

  it("maps Northern Ireland rows to the United Kingdom, RoI to Ireland", () => {
    const rows = parse();
    const belfast = rows.find((r) =>
      (r.payload.address as { line1?: string }).line1?.includes("Belfast"),
    );
    expect((belfast?.payload.address as { country?: string }).country).toBe("United Kingdom");
    expect(belfast?.payload.usageCost).toBe("Fast: £0.462 /kWh (VAT 20%)");
    expect((rows[0].payload.address as { country?: string }).country).toBe("Ireland");
  });
});
