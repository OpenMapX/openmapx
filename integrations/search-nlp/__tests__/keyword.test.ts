import { describe, expect, it } from "vitest";
import { keywordProvider } from "../providers/keyword";

const ctx = {
  mapCenter: [2.3522, 48.8566] as [number, number],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

function selectorKeys(selectors: { tags: { key: string; value?: string }[] }[]): string[] {
  return selectors.flatMap((s) => s.tags.map((t) => `${t.key}=${t.value}`));
}

describe("keywordProvider", () => {
  it("has id 'keyword' and requiresNetwork false", () => {
    expect(keywordProvider.id).toBe("keyword");
    expect(keywordProvider.requiresNetwork).toBe(false);
  });

  it("'coffee with outdoor seating' → amenity=cafe selector, outdoor_seating require, current_view", async () => {
    const result = await keywordProvider.parseQuery("coffee with outdoor seating", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=cafe");
    expect(result.filter.require).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "outdoor_seating", value: "yes" })]),
    );
    expect(result.spatial_constraint).toEqual({ type: "current_view" });
  });

  it("'nearest pharmacy open now' → amenity=pharmacy selector, open_now, distance", async () => {
    const result = await keywordProvider.parseQuery("nearest pharmacy open now", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=pharmacy");
    expect(result.time_constraint).toEqual({ type: "open_now" });
    expect(result.sort_by).toBe("distance");
  });

  it("'closest coffee shop' → distance sort", async () => {
    const result = await keywordProvider.parseQuery("closest coffee shop", ctx);
    expect(result.sort_by).toBe("distance");
  });

  it("'Cafe Central' → low confidence, empty selectors (proper name suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Cafe Central", ctx);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.filter.selectors).toEqual([]);
  });

  it("'Hotel Adlon' → low confidence, empty selectors (proper name suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Hotel Adlon", ctx);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.filter.selectors).toEqual([]);
  });

  it("'Coffee Shop' → amenity=cafe selector (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Coffee Shop", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=cafe");
    expect(result.confidence).toBe(0.6);
  });

  it("'Gas Station' → amenity=fuel selector (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Gas Station", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=fuel");
    expect(result.confidence).toBe(0.6);
  });

  it("'Parking Lot' → amenity=parking selector (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Parking Lot", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=parking");
    expect(result.confidence).toBe(0.6);
  });

  it("'coffee shop' (lowercase) → amenity=cafe selector", async () => {
    const result = await keywordProvider.parseQuery("coffee shop", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=cafe");
    expect(result.confidence).toBe(0.6);
  });

  it("'cafe' (single word) → amenity=cafe selector, not suppressed", async () => {
    const result = await keywordProvider.parseQuery("cafe", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=cafe");
    expect(result.confidence).toBe(0.6);
  });

  it("'vegan restaurant with wifi' → restaurant selector, diet:vegan and internet_access require predicates", async () => {
    const result = await keywordProvider.parseQuery("vegan restaurant with wifi", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys.some((k) => k.startsWith("amenity=") || k.startsWith("cuisine="))).toBe(true);
    expect(result.filter.require).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "diet:vegan", value: "yes" }),
        expect.objectContaining({ key: "internet_access", value: "wlan" }),
      ]),
    );
  });

  it("'bar open 24h near me' → bar selector, open_24h, distance", async () => {
    const result = await keywordProvider.parseQuery("bar open 24h near me", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys.some((k) => k.includes("bar") || k.includes("pub"))).toBe(true);
    expect(result.time_constraint).toEqual({ type: "open_24h" });
    expect(result.sort_by).toBe("distance");
  });

  it("'wheelchair accessible museum' → museum selector, wheelchair require predicate", async () => {
    const result = await keywordProvider.parseQuery("wheelchair accessible museum", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys.some((k) => k.includes("museum"))).toBe(true);
    expect(result.filter.require).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "wheelchair", value: "yes" })]),
    );
  });

  it("'ev charger' → amenity=charging_station selector", async () => {
    const result = await keywordProvider.parseQuery("ev charger", ctx);
    const keys = selectorKeys(result.filter.selectors);
    expect(keys).toContain("amenity=charging_station");
  });

  it("matched categories produce confidence 0.6", async () => {
    const result = await keywordProvider.parseQuery("hotel near me", ctx);
    expect(result.confidence).toBe(0.6);
  });

  it("unmatched query produces confidence 0.2", async () => {
    const result = await keywordProvider.parseQuery("Hauptbahnhof Hamburg", ctx);
    expect(result.confidence).toBe(0.2);
  });

  it("spatial_constraint is always current_view", async () => {
    const result = await keywordProvider.parseQuery("supermarket", ctx);
    expect(result.spatial_constraint).toEqual({ type: "current_view" });
  });

  it("deduplicated categories (no repeated selectors from same category)", async () => {
    const result = await keywordProvider.parseQuery("coffee cafe espresso latte", ctx);
    const cafeSelectors = result.filter.selectors.filter((s) =>
      s.tags.some((t) => t.key === "amenity" && t.value === "cafe"),
    );
    expect(cafeSelectors).toHaveLength(1);
  });
});
