import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseNzEvroam } from "../nz-evroam-parser.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/nz-evroam.geojson", import.meta.url)),
);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(buffer: Buffer = fixture): PoiRow[] {
  return Array.from(parseNzEvroam(buffer, { log }));
}

function featureCollection(features: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}

describe("parseNzEvroam", () => {
  it("parses features and keeps geometry.coordinates as [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(4);
    const ormiston = rows[0];
    expect(ormiston.lng).toBeCloseTo(174.912617279991);
    expect(ormiston.lat).toBeCloseTo(-36.9648860419307);
    expect(ormiston.payload.coordinates).toEqual([174.912617279991, -36.9648860419307]);
    expect(ormiston.payload.name).toBe("Ormiston Town Centre");
    expect(ormiston.poiId).toBe("02f61e5a-2f07-4f82-b988-cbc8ac601663");
  });

  it("parses a Type 2 Socketed connectorsList group", () => {
    const waikato = parse()[1];
    const connectors = waikato.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toMatchObject({
      type: "Type 2",
      currentType: "AC",
      powerKw: 7,
      quantity: 4,
    });
  });

  it("parses a Type 2 CCS group alongside a CHAdeMO group", () => {
    const porirua = parse()[2];
    const connectors = porirua.payload.connectors as Array<{
      type?: string;
      powerKw?: number;
      currentType?: string;
      quantity?: number;
    }>;
    expect(connectors).toHaveLength(2);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 25, quantity: 1 }),
        expect.objectContaining({ type: "CHAdeMO", currentType: "DC", powerKw: 25, quantity: 1 }),
      ]),
    );
  });

  it("parses multi-count groups (Count:3) and rolls status up to operational", () => {
    const bp = parse()[3];
    const connectors = bp.payload.connectors as Array<{ quantity?: number }>;
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", quantity: 3, powerKw: 150 }),
        expect.objectContaining({ type: "CHAdeMO", quantity: 1, powerKw: 150 }),
      ]),
    );
    expect(bp.payload.status).toBe("operational");
  });

  it("maps hasChargingCost to Paid/Free and is24Hours to 24/7", () => {
    const rows = parse();
    expect(rows[0].payload.usageCost).toBe("Free");
    expect(rows[0].payload.openingHours).toBe("24/7");
    expect(rows[1].payload.usageCost).toBe("Paid");
    expect(rows[0].payload.address).toEqual({
      line1: "240 Ormiston road, Flat Bush, Auckland, 2012, New Zealand",
      country: "New Zealand",
    });
    expect(rows[0].payload.operator).toEqual({
      name: "Todd Property Ormiston Town Centre Limited",
    });
  });

  it("dedupes rows by GlobalID and skips features missing coordinates", () => {
    const rows = parse(
      featureCollection([
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: { GlobalID: "dup-1", name: "Dup station", connectorsList: "" },
        },
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: { GlobalID: "dup-1", name: "Dup station again", connectorsList: "" },
        },
        {
          geometry: {},
          properties: { GlobalID: "no-coords", name: "No coords" },
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.name).toBe("Dup station");
  });

  it("falls back to OBJECTID when GlobalID is missing", () => {
    const rows = parse(
      featureCollection([
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: { OBJECTID: 12345, name: "No GlobalID", connectorsList: "" },
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].poiId).toBe("12345");
  });

  it("rolls status up to not-operational only when every connector is Inoperative", () => {
    const rows = parse(
      featureCollection([
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: {
            GlobalID: "all-down",
            name: "All down",
            connectorsList: "{DC, 50 kW, Type 2 CCS, Status: Inoperative, Count:2}",
          },
        },
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: {
            GlobalID: "mixed",
            name: "Mixed",
            connectorsList:
              "{DC, 50 kW, Type 2 CCS, Status: Inoperative, Count:1},{AC, 7 kW, Type 2 Socketed, Status: Operative, Count:1}",
          },
        },
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: { GlobalID: "no-list", name: "No connectors list", connectorsList: "" },
        },
      ]),
    );
    expect(rows.find((r) => r.poiId === "all-down")?.payload.status).toBe("not-operational");
    expect(rows.find((r) => r.poiId === "mixed")?.payload.status).toBe("operational");
    expect(rows.find((r) => r.poiId === "no-list")?.payload.status).toBe("unknown");
  });

  it("maps unrecognised connector type text to Unknown", () => {
    const rows = parse(
      featureCollection([
        {
          geometry: { coordinates: [174.9, -36.9] },
          properties: {
            GlobalID: "weird-type",
            name: "Weird connector",
            connectorsList: "{AC, 11 kW, Some New Plug, Status: Operative, Count:1}",
          },
        },
      ]),
    );
    const connectors = rows[0].payload.connectors as Array<{ type?: string }>;
    expect(connectors[0].type).toBe("Unknown");
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parse(Buffer.from("not json"))).toEqual([]);
  });
});
