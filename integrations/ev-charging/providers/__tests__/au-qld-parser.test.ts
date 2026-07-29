import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseAuQld } from "../au-qld-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/au-qld.csv", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseAuQld(fixture, { log }));
}

describe("parseAuQld", () => {
  it("parses quoted cells with embedded real newlines without splitting rows", () => {
    const rows = parse();
    expect(rows).toHaveLength(4);
    const gatton = rows[0];
    expect(gatton.payload.name).toBe("Gatton");
    expect(gatton.lng).toBeCloseTo(152.3350726);
    expect(gatton.lat).toBeCloseTo(-27.55140366);
    expect(gatton.payload.coordinates).toEqual([152.3350726, -27.55140366]);
  });

  it("keeps the multi-line Address cell intact and sets country to Australia", () => {
    const rows = parse();
    const brisbane = rows.find((r) => r.payload.name === "Brisbane");
    expect((brisbane?.payload.address as { line1?: string }).line1).toContain(
      "North Shore Hamilton",
    );
    expect((brisbane?.payload.address as { line1?: string }).line1).toContain(
      "281 MacArthur Ave, Hamilton QLD 4007",
    );
    expect((brisbane?.payload.address as { country?: string }).country).toBe("Australia");
  });

  it("maps Host to operator.name, and omits operator when Host is blank", () => {
    const rows = parse();
    const gatton = rows.find((r) => r.payload.name === "Gatton");
    expect(gatton?.payload.operator).toEqual({ name: "University of Queensland" });

    const marlborough = rows.find((r) => r.payload.name === "Marlborough");
    expect(marlborough?.payload.operator).toBeUndefined();
  });

  it("always reports operational status with no connector data", () => {
    const rows = parse();
    for (const row of rows) {
      expect(row.payload.status).toBe("operational");
      expect(row.payload.connectors).toEqual([]);
    }
  });
});
