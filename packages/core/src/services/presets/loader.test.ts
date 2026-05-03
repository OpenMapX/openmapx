import { describe, expect, it } from "vitest";
import { loadPresetIndex } from "./loader";

describe("loadPresetIndex", () => {
  const index = loadPresetIndex(["en", "de"]);

  it("loads both requested languages", () => {
    expect(index.has("en")).toBe(true);
    expect(index.has("de")).toBe(true);
  });

  it("indexes more than 1000 presets per language (sanity)", () => {
    expect(index.get("en")?.length).toBeGreaterThan(1000);
    expect(index.get("de")?.length).toBeGreaterThan(1000);
  });

  it("uses German names for German index", () => {
    // biome-ignore lint/style/noNonNullAssertion: safe to assert after has() check
    const de = index.get("de")!;
    const iceCream = de.find((e) => e.presetId === "amenity/ice_cream");
    expect(iceCream).toBeDefined();
    expect(iceCream?.normalizedName).toContain("eis");
    expect(iceCream?.normalizedTerms).toContain("eisdiele");
  });

  it("uses English names for English index", () => {
    // biome-ignore lint/style/noNonNullAssertion: safe to assert after has() check
    const en = index.get("en")!;
    const iceCream = en.find((e) => e.presetId === "amenity/ice_cream");
    expect(iceCream).toBeDefined();
    expect(iceCream?.normalizedName).toBe("ice cream shop");
    expect(iceCream?.displayName).toBe("Ice Cream Shop");
  });

  it("falls back to English when a translation file is missing", () => {
    const fallback = loadPresetIndex(["zz"]);
    const enLen = index.get("en")?.length;
    expect(fallback.get("zz")?.length).toBe(enLen);
  });

  it("preserves OSM tags from the base preset file", () => {
    // biome-ignore lint/style/noNonNullAssertion: safe to assert after has() check
    const en = index.get("en")!;
    const fuel = en.find((e) => e.presetId === "amenity/fuel");
    expect(fuel?.tags).toEqual({ amenity: "fuel" });
  });

  it("excludes presets where searchable === false", () => {
    // biome-ignore lint/style/noNonNullAssertion: safe to assert after has() check
    const en = index.get("en")!;
    const generic = en.find((e) => e.presetId === "amenity");
    // The catch-all amenity preset is searchable=false in the schema; if this assertion
    // ever fails, double-check by inspecting the raw JSON before changing the test.
    expect(generic).toBeUndefined();
  });
});
