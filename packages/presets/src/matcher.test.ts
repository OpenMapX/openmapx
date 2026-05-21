import { describe, expect, it } from "vitest";
import { loadPresetIndex } from "./loader";
import { canonicalTagSet, searchPresets } from "./matcher";

const index = loadPresetIndex(["en", "de"]);
const noSuppression = new Set<string>();

describe("searchPresets", () => {
  it("finds an OSM ice-cream shop by German term 'Eisdiele'", () => {
    const results = searchPresets(index, {
      q: "eisdiele",
      lang: "de",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results[0].id).toBe("amenity/ice_cream");
    expect(results[0].matchedOn).toBe("term");
    expect(results[0].tags).toEqual({ amenity: "ice_cream" });
  });

  it("finds fuel by German colloquial 'Tanke'", () => {
    const results = searchPresets(index, {
      q: "tanke",
      lang: "de",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results[0].id).toBe("amenity/fuel");
  });

  it("finds pharmacy by German 'Apotheke'", () => {
    const results = searchPresets(index, {
      q: "apotheke",
      lang: "de",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results[0].id).toBe("amenity/pharmacy");
  });

  it("finds ice cream shop by English query and returns the display-cased name", () => {
    const results = searchPresets(index, {
      q: "ice cream",
      lang: "en",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results[0].id).toBe("amenity/ice_cream");
    expect(results[0].matchedOn).toBe("name");
    expect(results[0].name).toBe("Ice Cream Shop");
  });

  it("returns empty for nonsense", () => {
    const results = searchPresets(index, {
      q: "qzxqzxqzx",
      lang: "en",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results).toEqual([]);
  });

  it("is case- and diacritic-insensitive", () => {
    const a = searchPresets(index, {
      q: "CAFÉ",
      lang: "en",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    const b = searchPresets(index, {
      q: "cafe",
      lang: "en",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.length).toBeGreaterThan(0);
  });

  it("falls back to English when language is missing", () => {
    const results = searchPresets(index, {
      q: "ice cream",
      lang: "fr",
      limit: 8,
      suppressTagSets: noSuppression,
    });
    expect(results[0].id).toBe("amenity/ice_cream");
  });

  it("respects the limit", () => {
    const results = searchPresets(index, {
      q: "shop",
      lang: "en",
      limit: 3,
      suppressTagSets: noSuppression,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("suppresses presets whose tag-set is in suppressTagSets", () => {
    const suppress = new Set([canonicalTagSet({ amenity: "ice_cream" })]);
    const results = searchPresets(index, {
      q: "ice cream",
      lang: "en",
      limit: 8,
      suppressTagSets: suppress,
    });
    expect(results.find((r) => r.id === "amenity/ice_cream")).toBeUndefined();
  });

  it("ignores empty queries", () => {
    expect(
      searchPresets(index, { q: "", lang: "en", limit: 8, suppressTagSets: noSuppression }),
    ).toEqual([]);
    expect(
      searchPresets(index, { q: "  ", lang: "en", limit: 8, suppressTagSets: noSuppression }),
    ).toEqual([]);
  });
});

describe("canonicalTagSet", () => {
  it("is order-independent", () => {
    expect(canonicalTagSet({ a: "1", b: "2" })).toBe(canonicalTagSet({ b: "2", a: "1" }));
  });
  it("differs between distinct tag sets", () => {
    expect(canonicalTagSet({ amenity: "fuel" })).not.toBe(
      canonicalTagSet({ amenity: "restaurant" }),
    );
  });
});
