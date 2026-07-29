import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseAuVic } from "../au-vic-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/au-vic.json", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseAuVic(fixture, { log }));
}

type Connector = { type?: string; powerKw?: number; currentType?: string; quantity?: number };

function byName(rows: PoiRow[], name: string): PoiRow | undefined {
  return rows.find((r) => r.payload.name === name);
}

describe("parseAuVic", () => {
  it("reads geometry.coordinates as [lng, lat] and uses feature.id as the poiId", () => {
    const rows = parse();
    expect(rows).toHaveLength(6);
    const tatura = rows[0];
    expect(tatura.poiId).toBe("dcav_site.1");
    expect(tatura.lng).toBeCloseTo(145.226061);
    expect(tatura.lat).toBeCloseTo(-36.44026);
    expect(tatura.payload.coordinates).toEqual([145.226061, -36.44026]);
  });

  it("prefers company over lead_organisation for operator.name, falling back when company is null", () => {
    const rows = parse();
    expect(byName(rows, "Tatura")?.payload.operator).toEqual({ name: "Tatura Carwash" });
    expect(byName(rows, "Moe")?.payload.operator).toEqual({ name: "Chargefox" });
    expect(byName(rows, "Glen Waverley")?.payload.operator).toEqual({ name: "City of Monash" });
  });

  it("parses comma- and 'and'-separated plug_type tokens into typed connectors", () => {
    const rows = parse();
    const tatura = byName(rows, "Tatura")?.payload.connectors as Connector[];
    expect(tatura).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", quantity: 1 }),
        expect.objectContaining({ type: "CHAdeMO", quantity: 1 }),
      ]),
    );

    const moe = byName(rows, "Moe")?.payload.connectors as Connector[];
    expect(moe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CHAdeMO", quantity: 2, currentType: "DC" }),
        expect.objectContaining({ type: "CCS", quantity: 4, currentType: "DC" }),
      ]),
    );

    const glenWaverley = byName(rows, "Glen Waverley")?.payload.connectors as Connector[];
    expect(glenWaverley).toEqual([
      expect.objectContaining({ type: "Type 2", quantity: 2, currentType: "AC" }),
    ]);
  });

  it("returns no connectors when plug_type is blank", () => {
    const rows = parse();
    expect(byName(rows, "Anglesea")?.payload.connectors).toEqual([]);
  });

  it("treats a past estimated_project_completion (including odd formats) as operational", () => {
    const rows = parse();
    expect(byName(rows, "Queenscliff")?.payload.status).toBe("operational");
    // Leading-space free-text month/year still parses.
    expect(byName(rows, "Anglesea")?.payload.status).toBe("operational");
    expect(byName(rows, "Tatura")?.payload.status).toBe("operational");
  });

  it("treats a future estimated_project_completion as planned", () => {
    const rows = parse();
    expect(byName(rows, "Ballarat Future Site")?.payload.status).toBe("planned");
  });
});
