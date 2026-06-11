import { describe, expect, it } from "vitest";
import { keywordProvider } from "../providers/keyword";

const ctx = {
  mapCenter: [2.3522, 48.8566] as [number, number],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

describe("keywordProvider", () => {
  it("has id 'keyword' and requiresNetwork false", () => {
    expect(keywordProvider.id).toBe("keyword");
    expect(keywordProvider.requiresNetwork).toBe(false);
  });

  it("'coffee with outdoor seating' → cafes, outdoor_seating yes, current_view", async () => {
    const result = await keywordProvider.parseQuery("coffee with outdoor seating", ctx);
    expect(result.categories).toContain("cafes");
    expect(result.attributes.outdoor_seating).toBe("yes");
    expect(result.spatial_constraint).toEqual({ type: "current_view" });
  });

  it("'nearest pharmacy open now' → pharmacies, open_now, distance", async () => {
    const result = await keywordProvider.parseQuery("nearest pharmacy open now", ctx);
    expect(result.categories).toContain("pharmacies");
    expect(result.time_constraint).toEqual({ type: "open_now" });
    expect(result.sort_by).toBe("distance");
  });

  it("'closest coffee shop' → distance sort", async () => {
    const result = await keywordProvider.parseQuery("closest coffee shop", ctx);
    expect(result.sort_by).toBe("distance");
  });

  it("'Cafe Central' → low confidence, empty categories (proper name suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Cafe Central", ctx);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.categories).toEqual([]);
  });

  it("'Hotel Adlon' → low confidence, empty categories (proper name suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Hotel Adlon", ctx);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.categories).toEqual([]);
  });

  it("'Coffee Shop' → cafes (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Coffee Shop", ctx);
    expect(result.categories).toContain("cafes");
    expect(result.confidence).toBe(0.6);
  });

  it("'Gas Station' → fuel (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Gas Station", ctx);
    expect(result.categories).toContain("fuel");
    expect(result.confidence).toBe(0.6);
  });

  it("'Parking Lot' → parking (generic noun, NOT suppressed)", async () => {
    const result = await keywordProvider.parseQuery("Parking Lot", ctx);
    expect(result.categories).toContain("parking");
    expect(result.confidence).toBe(0.6);
  });

  it("'coffee shop' (lowercase) → cafes", async () => {
    const result = await keywordProvider.parseQuery("coffee shop", ctx);
    expect(result.categories).toContain("cafes");
    expect(result.confidence).toBe(0.6);
  });

  it("'cafe' (single word) → cafes, not suppressed", async () => {
    const result = await keywordProvider.parseQuery("cafe", ctx);
    expect(result.categories).toContain("cafes");
    expect(result.confidence).toBe(0.6);
  });

  it("'vegan restaurant with wifi' → restaurants, diet:vegan yes, internet_access wlan", async () => {
    const result = await keywordProvider.parseQuery("vegan restaurant with wifi", ctx);
    expect(result.categories).toContain("restaurants");
    expect(result.attributes["diet:vegan"]).toBe("yes");
    expect(result.attributes.internet_access).toBe("wlan");
  });

  it("'bar open 24h near me' → bars, open_24h, distance", async () => {
    const result = await keywordProvider.parseQuery("bar open 24h near me", ctx);
    expect(result.categories).toContain("bars");
    expect(result.time_constraint).toEqual({ type: "open_24h" });
    expect(result.sort_by).toBe("distance");
  });

  it("'wheelchair accessible museum' → museums, wheelchair yes", async () => {
    const result = await keywordProvider.parseQuery("wheelchair accessible museum", ctx);
    expect(result.categories).toContain("museums");
    expect(result.attributes.wheelchair).toBe("yes");
  });

  it("'ev charger' → ev_charging", async () => {
    const result = await keywordProvider.parseQuery("ev charger", ctx);
    expect(result.categories).toContain("ev_charging");
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

  it("deduplicated categories (no repeats)", async () => {
    const result = await keywordProvider.parseQuery("coffee cafe espresso latte", ctx);
    const cafesCount = result.categories.filter((c) => c === "cafes").length;
    expect(cafesCount).toBe(1);
  });
});
