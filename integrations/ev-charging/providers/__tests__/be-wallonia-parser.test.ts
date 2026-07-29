import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { BE_WALLONIA_URL, parseBeWallonia, parseWalloniaRows } from "../be-wallonia-parser.js";

const csv = readFileSync(fileURLToPath(new URL("./fixtures/be-wallonia.csv", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const WALLONIA_BBOX = { west: 2.8, south: 49.5, east: 6.4, north: 50.8 };
function inWallonia([lng, lat]: [number, number]): boolean {
  return (
    lng >= WALLONIA_BBOX.west &&
    lng <= WALLONIA_BBOX.east &&
    lat >= WALLONIA_BBOX.south &&
    lat <= WALLONIA_BBOX.north
  );
}

describe("parseWalloniaRows", () => {
  it("reprojects EPSG:31370 WKT to WGS84 against the SPW control point", () => {
    const rows = parseWalloniaRows(csv.toString("utf8"));
    const namur = rows.find((r) => r.poiId === "loc-namur");
    expect(namur).toBeDefined();
    expect(namur?.lng).toBeCloseTo(4.858691, 5);
    expect(namur?.lat).toBeCloseTo(50.469649, 5);
    expect(inWallonia(namur?.payload.coordinates as [number, number])).toBe(true);
  });

  it("groups per-connector rows by EMPLACEMENT_ID into one station", () => {
    const rows = parseWalloniaRows(csv.toString("utf8"));
    expect(rows).toHaveLength(2);
    const namur = rows.find((r) => r.poiId === "loc-namur");
    const connectors = namur?.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
    }>;
    expect(connectors).toHaveLength(3);
    expect(connectors.every((c) => c.type === "Type 2" && c.currentType === "AC")).toBe(true);
    expect((namur?.payload.operator as { name?: string }).name).toBe("50 five");
    expect((namur?.payload.address as { postcode?: string; country?: string }).postcode).toBe(
      "5000",
    );
    expect(namur?.payload.updatedAt).toBe("2026-04-11T00:00:00");
  });

  it("infers DC/CCS for higher-power tiers", () => {
    const rows = parseWalloniaRows(csv.toString("utf8"));
    const dc = rows.find((r) => r.poiId === "loc-dc");
    const connectors = dc?.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
    }>;
    expect(connectors[0]).toMatchObject({ type: "CCS", currentType: "DC", powerKw: 150 });
    expect(inWallonia(dc?.payload.coordinates as [number, number])).toBe(true);
  });

  it("unzips the archive and parses the CSV member", () => {
    const zipped = zipSync({ "BORNES_RECHARGE_XY.csv": new Uint8Array(csv) });
    const rows = Array.from(parseBeWallonia(Buffer.from(zipped), { log }));
    expect(rows).toHaveLength(2);
    expect(BE_WALLONIA_URL).toContain("BORNES_RECHARGE_CSV.zip");
  });
});
