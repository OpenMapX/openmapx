import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseLuChargy } from "../lu-chargy-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/lu-chargy.kml", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseLuChargy(fixture, { log }));
}

describe("parseLuChargy", () => {
  it("parses every placemark and keeps coordinates in [lng, lat] order (no swap)", () => {
    const rows = parse();
    expect(rows).toHaveLength(6);
    const superChargy = rows[0];
    expect(superChargy.lng).toBeCloseTo(5.972754);
    expect(superChargy.lat).toBeCloseTo(49.634833);
    expect(superChargy.payload.coordinates).toEqual([5.972754, 49.634833]);
    expect(superChargy.payload.name).toBe("SuperChargy - Aire de Capellen direction Luxembourg");
  });

  it("sets address line1/country and operator from the fixed Chargy operator", () => {
    const [superChargy] = parse();
    expect(superChargy.payload.address).toEqual({
      line1: "Aire de Capellen Sud, L-8309 Capellen Luxembourg",
      country: "Luxembourg",
    });
    expect(superChargy.payload.operator).toEqual({ name: "Chargy" });
    expect(superChargy.payload.sourceUrl).toBe(
      "https://data.public.lu/fr/datasets/r/22f9d77a-5138-4b02-b315-15f306b77034",
    );
  });

  it("maps styleUrl to status: #AVAILABLE -> operational, #UNAVAILABLE -> unknown (not broken)", () => {
    const rows = parse();
    const superChargy = rows[0];
    const mersch = rows.find((r) => r.payload.name === "Mersch - P+R rue Lohr");
    expect(superChargy.payload.status).toBe("operational");
    expect(mersch?.payload.status).toBe("unknown");
  });

  it("flattens repeated chargingdevice JSON entries into one connector each, using maxchspeed for power", () => {
    const [superChargy] = parse();
    const connectors = superChargy.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    // 4 chargingdevice entries: two single-connector 350kW devices, one
    // single-connector 350kW device, and one 3-connector 400kW device = 6 total.
    expect(connectors).toHaveLength(6);
    expect(connectors.every((c) => c.powerKw === 350 || c.powerKw === 400)).toBe(true);
    expect(connectors.every((c) => c.quantity === 1)).toBe(true);
  });

  it("treats the connector 'type' label as unreliable above the AC ceiling: high power -> Unknown/DC", () => {
    const [superChargy] = parse();
    const connectors = superChargy.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
    }>;
    // Chargy's KML calls all of these "Type 2" even at 350-400kW; the parser
    // must not trust that label above ~43kW.
    expect(connectors.every((c) => c.type === "Unknown" && c.currentType === "DC")).toBe(true);
  });

  it("keeps the Type 2 / AC label for normal-power (<=43kW) stations", () => {
    const rows = parse();
    const mersch = rows.find((r) => r.payload.name === "Mersch - P+R rue Lohr");
    const connectors = mersch?.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
      quantity?: number;
    }>;
    // 3 chargingdevice entries x 2 connectors each = 6.
    expect(connectors).toHaveLength(6);
    for (const conn of connectors) {
      expect(conn.type).toBe("Type 2");
      expect(conn.currentType).toBe("AC");
      expect(conn.powerKw).toBe(22);
      expect(conn.quantity).toBe(1);
    }
  });

  it("dedupes by poiId (stable hash of name + coordinates)", () => {
    const rows = parse();
    const ids = new Set(rows.map((r) => r.poiId));
    expect(ids.size).toBe(rows.length);
  });
});
