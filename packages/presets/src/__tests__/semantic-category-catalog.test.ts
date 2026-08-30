import { CATEGORY_DEFINITIONS, CATEGORY_FILTERS, normalizeFilter } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { buildSemanticCategoryCatalog } from "../semantic-category-catalog";

describe("buildSemanticCategoryCatalog", () => {
  it("returns one sorted document for every executable product category", () => {
    const expected = CATEGORY_DEFINITIONS.map(({ id }) => id)
      .filter((id) => CATEGORY_FILTERS[id])
      .sort();
    const actual = buildSemanticCategoryCatalog();
    expect(actual.map(({ categoryId }) => categoryId)).toEqual(expected);
    expect(new Set(actual.map(({ categoryId }) => categoryId)).size).toBe(actual.length);
  });

  it("keeps narrower semantic evidence out of broad overlapping categories", () => {
    const byId = new Map(buildSemanticCategoryCatalog().map((item) => [item.categoryId, item]));
    expect(byId.get("cafes")?.document.toLowerCase()).toContain("café");
    expect(byId.get("restaurants")?.document.toLowerCase()).not.toContain("café");
    expect(byId.get("bars")?.document.toLowerCase()).toContain("pub");
    expect(byId.get("restaurants")?.document.toLowerCase()).not.toContain("amenity=pub");
    expect(byId.get("parks")?.document.toLowerCase()).toContain("leisure=park");
    expect(byId.get("activities")?.document.toLowerCase()).not.toContain("leisure=park");
  });

  it("emits executable filters and deterministic documents", () => {
    const first = buildSemanticCategoryCatalog();
    const second = buildSemanticCategoryCatalog();
    expect(second).toEqual(first);
    for (const item of first) {
      expect(item.document.trim()).not.toBe("");
      expect(item.labels.en.trim()).not.toBe("");
      expect(item.labels.de.trim()).not.toBe("");
      expect(normalizeFilter(item.filter).selectors.length).toBeGreaterThan(0);
      expect(JSON.stringify(item)).not.toContain('"*"');
    }
  });

  it("uses German iD evidence where present", () => {
    const byId = new Map(buildSemanticCategoryCatalog().map((item) => [item.categoryId, item]));
    expect(byId.get("pharmacies")?.document).toContain("Apotheke");
    expect(byId.get("libraries")?.document).toContain("Bibliothek");
  });
});
