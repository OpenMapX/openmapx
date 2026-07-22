import { describe, expect, it } from "vitest";
import { normalizeConnector } from "./normalize-connector.js";

describe("normalizeConnector", () => {
  it.each([
    ["IEC_62196_T2_COMBO", undefined, { standard: "ccs2", current: "dc" }],
    ["ccs", undefined, { standard: "ccs2", current: "dc" }],
    ["CCS2", "DC", { standard: "ccs2", current: "dc" }],
    ["CHAdeMO", undefined, { standard: "chademo", current: "dc" }],
    ["IEC_62196_T2", "AC_3_PHASE", { standard: "type2", current: "ac" }],
    ["Type 2", undefined, { standard: "type2", current: "ac" }],
    ["Type1", undefined, { standard: "type1", current: "ac" }],
    ["GBT_DC", undefined, { standard: "gbt_dc", current: "dc" }],
    ["Tesla (CCS)", undefined, { standard: "tesla_ccs", current: "dc" }],
    ["GB/T", undefined, { standard: "gbt_ac", current: "ac" }],
  ])("maps %s/%s -> %o", (type, current, expected) => {
    expect(normalizeConnector(type, current)).toEqual(expected);
  });

  it("returns null for unknown or empty types", () => {
    expect(normalizeConnector("wireless-magic")).toBeNull();
    expect(normalizeConnector(undefined)).toBeNull();
  });

  it("normalizes NACS to its own standard", () => {
    expect(normalizeConnector("NACS")?.standard).toBe("nacs");
    expect(normalizeConnector("nacs")?.standard).toBe("nacs");
    expect(normalizeConnector("Tesla (NACS)")?.standard).toBe("nacs");
  });

  it("treats NACS as DC", () => {
    expect(normalizeConnector("NACS")?.current).toBe("dc");
  });

  it("still maps a bare Tesla connector to tesla_ccs", () => {
    expect(normalizeConnector("Tesla")?.standard).toBe("tesla_ccs");
  });
});
