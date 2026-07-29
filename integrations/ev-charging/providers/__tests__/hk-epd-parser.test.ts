import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseHkEpd } from "../hk-epd-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/hk-epd.json", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseHkEpd(fixture, { log }));
}

function byPoiId(rows: PoiRow[], poiId: string): PoiRow {
  const row = rows.find((r) => r.poiId === poiId);
  if (!row) throw new Error(`missing row ${poiId}`);
  return row;
}

describe("parseHkEpd", () => {
  it("parses all fixture records and swaps coordinates to [lng, lat]", () => {
    const rows = parse();
    expect(rows).toHaveLength(6);
    const southside = byPoiId(rows, "PIS-00145");
    expect(southside.lng).toBeCloseTo(114.1669600525531);
    expect(southside.lat).toBeCloseTo(22.24704557740975);
    expect(southside.payload.coordinates).toEqual([114.1669600525531, 22.24704557740975]);
    expect(southside.payload.name).toBe("THE SOUTHSIDE");
    expect(southside.payload.address).toEqual({
      line1: "11 Heung Yip Road, Wong Chuk Hang, Hong Kong",
      country: "Hong Kong",
    });
  });

  it("maps chargingStandardID to connector type and DC/AC current type", () => {
    const rows = parse();
    const southside = byPoiId(rows, "PIS-00145");
    const connectors = southside.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
      quantity?: number;
    }>;
    // Combinations: CCS x2 (31), CHAdeMO (28), Type 2 (22).
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 100, quantity: 3 }),
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 100, quantity: 10 }),
        expect.objectContaining({ type: "CHAdeMO", currentType: "DC", powerKw: 100, quantity: 10 }),
        expect.objectContaining({ type: "Type 2", currentType: "AC", powerKw: 20, quantity: 234 }),
      ]),
    );
  });

  it("does not confuse chargerTypeID and chargingStandardID both being 22", () => {
    const rows = parse();
    const sportsGround = byPoiId(rows, "9977");
    const connectors = sportsGround.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
      quantity?: number;
    }>;
    // chargerTypeID 22 ("Fast Charger >=100kW") + chargingStandardID 31 (CCS) -> DC, 100kW.
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 100, quantity: 1 }),
        // chargerTypeID 22 + chargingStandardID 16 (GB/T) -> unmapped standard, AC.
        expect.objectContaining({ type: "Unknown", currentType: "AC", powerKw: 100, quantity: 1 }),
        // chargerTypeID 6 (20kW tier) + chargingStandardID 22 (Type 2 standard) -> AC, 20kW.
        expect.objectContaining({ type: "Type 2", currentType: "AC", powerKw: 20, quantity: 3 }),
      ]),
    );
  });

  it("maps chargingStandardID 19 (BS 1363) to Unknown/AC", () => {
    const rows = parse();
    const kwunTong = byPoiId(rows, "5058");
    const connectors = kwunTong.payload.connectors as Array<{
      type?: string;
      currentType?: string;
      powerKw?: number;
      quantity?: number;
    }>;
    expect(connectors).toEqual([
      expect.objectContaining({ type: "Unknown", currentType: "AC", powerKw: 7, quantity: 1 }),
    ]);
  });

  it("derives status from isEnable", () => {
    const rows = parse();
    expect(byPoiId(rows, "PIS-00145").payload.status).toBe("unknown");
    expect(byPoiId(rows, "222").payload.status).toBe("operational");
    expect(byPoiId(rows, "9977").payload.status).toBe("operational");
    expect(byPoiId(rows, "EPD_0458").payload.status).toBe("unknown");
  });

  it("takes the first ';'-split token of chargerOperatorAll as the operator name", () => {
    const rows = parse();
    expect(byPoiId(rows, "PIS-00145").payload.operator).toEqual({ name: "Tesla" });
    expect(byPoiId(rows, "222").payload.operator).toEqual({ name: "EPD (Operated by EV Power)" });
    expect(byPoiId(rows, "5058").payload.operator).toEqual({
      name: "The Hong Kong Housing Society",
    });
  });

  it("sets openingHours from openingHoursEn and sourceUrl to the feed URL", () => {
    const rows = parse();
    const southside = byPoiId(rows, "PIS-00145");
    expect(southside.payload.openingHours).toBe("24-hour");
    expect(southside.payload.sourceUrl).toBe(
      "https://ev-charger.epd.gov.hk/resource/ev_charger_avail/evca_ver_1_0.json",
    );
  });

  it("dedupes by poiId (carParkId)", () => {
    const rows = parse();
    const ids = rows.map((r) => r.poiId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
