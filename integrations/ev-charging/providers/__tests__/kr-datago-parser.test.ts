import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseKrDatago } from "../kr-datago-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/kr-datago.json", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function parse(): PoiRow[] {
  return Array.from(parseKrDatago(fixture, { log }));
}

describe("parseKrDatago", () => {
  it("drops rows with no coordinates and deduplicates identical rows", () => {
    const rows = parse();
    // 5 fixture rows: 2 are byte-identical duplicates, 1 has blank lat/lng.
    expect(rows).toHaveLength(3);
  });

  it("swaps coordinates to [lng, lat] and maps the address/operator/name", () => {
    const rows = parse();
    const miryang = rows.find((r) => r.payload.name === "내이동복지센터");
    expect(miryang?.lng).toBeCloseTo(128.746533);
    expect(miryang?.lat).toBeCloseTo(35.496994);
    expect(miryang?.payload.coordinates).toEqual([128.746533, 35.496994]);
    expect(miryang?.payload.address).toEqual({
      line1: "경상남도 밀양시 내이동 1193-15 내이동주민센터",
      state: "경상남도",
      country: "South Korea",
    });
    expect(miryang?.payload.operator).toEqual({ name: "에버온" });
  });

  it("maps AC완속 to a single Type 2 / AC connector using the slow charger count", () => {
    const rows = parse();
    const miryang = rows.find((r) => r.payload.name === "내이동복지센터");
    expect(miryang?.payload.connectors).toEqual([
      { type: "Type 2", currentType: "AC", quantity: 1 },
    ]);
  });

  it("maps a combined DC차데모+AC3상+DC콤보 fast type to CHAdeMO/Type 2/CCS, each at the fast count", () => {
    const rows = parse();
    const uljugun = rows.find((r) => r.payload.name === "울주군보건소");
    expect(uljugun?.payload.connectors).toEqual([
      { type: "Type 2", currentType: "AC", quantity: 2 },
      { type: "CHAdeMO", currentType: "DC", quantity: 1 },
      { type: "CCS", currentType: "DC", quantity: 1 },
      { type: "Type 2", currentType: "AC", quantity: 1 },
    ]);
  });

  it("maps a bare DC콤보 fast type to CCS at the fast charger count", () => {
    const rows = parse();
    const yangsan = rows.find((r) => r.payload.name === "하북문화의집");
    expect(yangsan?.payload.connectors).toEqual([{ type: "CCS", currentType: "DC", quantity: 2 }]);
  });

  it("maps opening hours, closed-day notes, phone notes, and reference date", () => {
    const rows = parse();
    const miryang = rows.find((r) => r.payload.name === "내이동복지센터");
    expect(miryang?.payload.openingHours).toBe("09:00 - 18:00");
    expect(miryang?.payload.notes).toEqual(["Closed: 평일", "Tel: 1661-7766"]);
    expect(miryang?.payload.updatedAt).toBe("2020-08-10");

    const uljugun = rows.find((r) => r.payload.name === "울주군보건소");
    expect(uljugun?.payload.openingHours).toBe("24/7");
  });
});
