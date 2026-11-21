import { assert, describe, expect, it } from "vitest";
import { loadPresetIndex } from "./loader";

describe("loadPresetIndex", () => {
  const index = loadPresetIndex(["en", "de"]);
  const presetsFor = (locale: string) => {
    const presets = index.get(locale);
    assert.isDefined(presets, `no presets indexed for ${locale}`);
    return presets;
  };

  it("indexes more than 1000 presets per language (sanity)", () => {
    expect(index.get("en")?.length).toBeGreaterThan(1000);
    expect(index.get("de")?.length).toBeGreaterThan(1000);
  });

  it("uses German names for German index", () => {
    const de = presetsFor("de");
    const iceCream = de.find((e) => e.presetId === "amenity/ice_cream");
    expect(iceCream).toBeDefined();
    expect(iceCream?.normalizedName).toContain("eis");
    expect(iceCream?.normalizedTerms).toContain("eisdiele");
  });

  it("uses English names for English index", () => {
    const en = presetsFor("en");
    const iceCream = en.find((e) => e.presetId === "amenity/ice_cream");
    expect(iceCream).toBeDefined();
    expect(iceCream?.normalizedName).toBe("ice cream shop");
    expect(iceCream?.displayName).toBe("Ice Cream Shop");
  });

  it("falls back to English when a translation file is missing", () => {
    const fallback = loadPresetIndex(["zz"]);
    expect(fallback.get("zz")).toEqual(index.get("en"));
  });

  it("preserves OSM tags from the base preset file", () => {
    const en = presetsFor("en");
    const fuel = en.find((e) => e.presetId === "amenity/fuel");
    expect(fuel?.tags).toEqual({ amenity: "fuel" });
  });

  it("excludes presets where searchable === false", () => {
    const en = presetsFor("en");
    const generic = en.find((e) => e.presetId === "amenity");
    // The catch-all amenity preset is searchable=false in the schema; if this assertion
    // ever fails, double-check by inspecting the raw JSON before changing the test.
    expect(generic).toBeUndefined();
  });
});
