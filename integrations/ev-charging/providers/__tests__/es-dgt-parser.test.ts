import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseEsDgt } from "../es-dgt-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/es-dgt.xml", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseEsDgt(fixture, { log }));
}

describe("parseEsDgt", () => {
  it("parses all sites and swaps DATEX lat/lon into [lng, lat] coordinates", () => {
    const rows = parse();
    expect(rows).toHaveLength(3);

    const carrerDelCallao = rows.find((r) => r.poiId === "9TOKBPBKRBJVLI0RR4XG");
    expect(carrerDelCallao).toBeDefined();
    expect(carrerDelCallao?.lng).toBeCloseTo(2.670856);
    expect(carrerDelCallao?.lat).toBeCloseTo(39.564915);
    expect(carrerDelCallao?.payload.coordinates).toEqual([2.670856, 39.564915]);
    expect(carrerDelCallao?.payload.name).toBe("Carrer_del_Callao");
  });

  it("strips the Spanish address labels and takes state from address order 4", () => {
    const rows = parse();
    const consum = rows.find((r) => r.poiId === "IXBKAMF4GUCULLK2GRK4");
    expect(consum?.payload.address).toEqual({
      line1: "Sant Ferran ,8-16",
      town: "Almassora",
      state: "Comunitat Valenciana",
      postcode: "12550",
      country: "Spain",
    });
  });

  it("reads the operator name from operator/name/values/value", () => {
    const rows = parse();
    const consum = rows.find((r) => r.poiId === "IXBKAMF4GUCULLK2GRK4");
    expect(consum?.payload.operator).toEqual({ name: "CHARGING TOGETHER SL" });
  });

  it("converts watts to kW and normalises connector type/current for a Type 2 AC site", () => {
    const rows = parse();
    const carrerDelCallao = rows.find((r) => r.poiId === "9TOKBPBKRBJVLI0RR4XG");
    const connectors = carrerDelCallao?.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    expect(connectors).toHaveLength(2);
    for (const conn of connectors) {
      expect(conn).toMatchObject({
        type: "Type 2",
        currentType: "AC",
        powerKw: 22.17,
        quantity: 1,
      });
    }
  });

  it("flattens refillPoint/connector across multiple stations for CCS mode4DC sites", () => {
    const rows = parse();
    const consum = rows.find((r) => r.poiId === "IXBKAMF4GUCULLK2GRK4");
    const connectors = consum?.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
    }>;
    expect(connectors).toHaveLength(4);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 50 }),
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 100 }),
      ]),
    );
  });

  it("maps chademo connectors alongside CCS ones within the same refillPoint", () => {
    const rows = parse();
    const restaurante = rows.find((r) => r.poiId === "LUYQXKE5OUXG1ZADLPMV");
    const connectors = restaurante?.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
    }>;
    // 6 refill points with a single CCS connector + 2 refill points pairing a
    // chademo connector with a CCS connector = 10 connectors total.
    expect(connectors).toHaveLength(10);
    const chademo = connectors.filter((c) => c.type === "CHAdeMO");
    expect(chademo).toHaveLength(2);
    for (const conn of chademo) {
      expect(conn).toMatchObject({ currentType: "DC", powerKw: 50 });
    }
  });
});
