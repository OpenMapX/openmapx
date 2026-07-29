import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseCyCynap } from "../cy-cynap-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/cy-cynap.xml", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseCyCynap(fixture, { log }));
}

describe("parseCyCynap", () => {
  it("parses rows and swaps lat-before-lon coordinates to [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(3);
    const petrolina = rows[0];
    expect(petrolina.lng).toBeCloseTo(33.601899147034);
    expect(petrolina.lat).toBeCloseTo(34.92514226471998);
    expect(petrolina.payload.coordinates).toEqual([33.601899147034, 34.92514226471998]);
    expect(petrolina.payload.name).toBe("Petrolina GSZ Station (150kW)");
  });

  it("builds one connector per connectorType with mapped type, power (already kW), and current type", () => {
    const [petrolina] = parse();
    const connectors = petrolina.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    expect(connectors).toHaveLength(2);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "Type 2", powerKw: 300, currentType: "DC", quantity: 2 }),
        expect.objectContaining({ type: "CCS", powerKw: 300, currentType: "DC", quantity: 2 }),
      ]),
    );
  });

  it("maps chargingPointStatus operational/unavailable to operational/not-operational", () => {
    const rows = parse();
    expect(rows[0].payload.status).toBe("operational");
    expect(rows[1].payload.status).toBe("not-operational");
    expect(rows[2].payload.status).toBe("not-operational");
  });

  it("falls back to chargingPointOwner when chargingPointOperator is empty", () => {
    const rows = parse();
    const oneTower2301 = rows[1];
    expect(oneTower2301.payload.operator).toEqual({ name: "Petrolina (Holdings) Public Ltd." });

    const oneTower2901 = rows[2];
    expect(oneTower2901.payload.name).toBe("OneTower 2901 (22kW)");
    expect(oneTower2901.payload.operator).toEqual({ name: "D.A One Property Management Ltd." });
  });

  it("carries address, opening hours, updatedAt, and sourceUrl", () => {
    const [petrolina] = parse();
    expect(petrolina.payload.address).toEqual({
      line1: "Georgiou Christodoulidi Avenue, 6043, Larnaca",
      country: "Cyprus",
    });
    expect(petrolina.payload.openingHours).toBe("24h");
    expect(petrolina.payload.updatedAt).toBe("2023-07-05");
    expect(petrolina.payload.sourceUrl).toBe(
      "https://fixcyprus.cy/gnosis/open/api/nap/datasets/electric_vehicle_chargers/",
    );
  });
});
