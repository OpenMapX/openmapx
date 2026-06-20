import { describe, expect, it } from "vitest";
import { openMapXCategoryToOverture, overtureCategoryToOpenMapX } from "../overtureCategoryMap";

// Commercial CategoryIds that must have at least one Overture leaf mapping
const EXPECTED_COMMERCIAL_CATEGORIES = [
  "restaurants",
  "cafes",
  "bars",
  "hotels",
  "supermarkets",
  "banks",
  "fuel",
  "shopping_malls",
  "bookstores",
  "pharmacies",
  "bakeries",
  "nightlife",
  "gyms",
  "hairdressers",
  "laundromats",
  "opticians",
  "car_rental",
  "car_repair",
  "veterinarians",
  "markets",
  "cinemas",
] as const;

// OSM-only (non-commercial) CategoryIds that should NOT have Overture mappings
const OSM_ONLY_CATEGORIES = ["drinking_water", "viewpoints", "aeds"] as const;

describe("openMapXCategoryToOverture — commercial categories have mappings", () => {
  for (const cat of EXPECTED_COMMERCIAL_CATEGORIES) {
    it(`"${cat}" resolves to at least one Overture leaf`, () => {
      const leaves = openMapXCategoryToOverture(cat);
      expect(leaves.length).toBeGreaterThan(0);
    });
  }
});

describe("openMapXCategoryToOverture — OSM-only categories have no Overture mapping", () => {
  for (const cat of OSM_ONLY_CATEGORIES) {
    it(`"${cat}" maps to nothing`, () => {
      const leaves = openMapXCategoryToOverture(cat);
      expect(leaves).toHaveLength(0);
    });
  }
});

describe("overtureCategoryToOpenMapX — Overture leaves resolve to CategoryId", () => {
  it("'restaurant' maps to 'restaurants'", () => {
    expect(overtureCategoryToOpenMapX("restaurant")).toBe("restaurants");
  });

  it("'coffee_shop' maps to 'cafes'", () => {
    expect(overtureCategoryToOpenMapX("coffee_shop")).toBe("cafes");
  });

  it("'bar' maps to 'bars'", () => {
    expect(overtureCategoryToOpenMapX("bar")).toBe("bars");
  });

  it("'hotel' maps to 'hotels'", () => {
    expect(overtureCategoryToOpenMapX("hotel")).toBe("hotels");
  });

  it("'gas_station' maps to 'fuel'", () => {
    expect(overtureCategoryToOpenMapX("gas_station")).toBe("fuel");
  });

  it("'pharmacy' maps to 'pharmacies'", () => {
    expect(overtureCategoryToOpenMapX("pharmacy")).toBe("pharmacies");
  });

  it("unknown leaf returns undefined", () => {
    expect(overtureCategoryToOpenMapX("definitely_not_a_category")).toBeUndefined();
  });

  it("empty string returns undefined", () => {
    expect(overtureCategoryToOpenMapX("")).toBeUndefined();
  });
});
