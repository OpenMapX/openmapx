import { describe, expect, it } from "vitest";
import {
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOvertureConcepts,
  overtureTaxonomyToOpenMapX,
} from "../overtureCategoryMap";

describe("Overture category interoperability bridge", () => {
  it("only exposes categories with explicit cross-provider semantics", () => {
    expect(OVERTURE_COMMERCIAL_CATEGORIES).toContain("restaurants");
    expect(OVERTURE_COMMERCIAL_CATEGORIES).toContain("cafes");
    expect(OVERTURE_COMMERCIAL_CATEGORIES).not.toContain("drinking_water");
  });

  it("maps UI categories to a small set of broad Overture concepts", () => {
    expect(openMapXCategoryToOvertureConcepts("restaurants")).toEqual(["restaurant"]);
    expect(openMapXCategoryToOvertureConcepts("cafes")).toEqual([
      "cafe",
      "coffee_shop",
      "tea_house",
    ]);
    expect(openMapXCategoryToOvertureConcepts("drinking_water")).toEqual([]);
  });

  it("classifies new specific leaves through Overture's hierarchy", () => {
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "casual_eatery",
        primary: "future_new_restaurant_leaf",
        hierarchy: ["food_and_drink", "restaurant", "future_new_restaurant_leaf"],
      }),
    ).toBe("restaurants");
  });

  it("uses basic, primary, and alternate categories when hierarchy is unavailable", () => {
    expect(overtureTaxonomyToOpenMapX({ basicCategory: "hospital" })).toBe("hospitals");
    expect(overtureTaxonomyToOpenMapX({ primary: "museum" })).toBe("museums");
    expect(overtureTaxonomyToOpenMapX({ alternates: ["gas_station"] })).toBe("fuel");
  });

  it("does not guess an OpenMapX category for unrelated taxonomy values", () => {
    expect(
      overtureTaxonomyToOpenMapX({
        primary: "advertising_agency",
        hierarchy: ["services_and_business", "advertising_agency"],
      }),
    ).toBeUndefined();
  });

  it("keeps the bridge compact rather than mirroring the 2k-leaf taxonomy", () => {
    const conceptCount = OVERTURE_COMMERCIAL_CATEGORIES.reduce(
      (total, category) => total + openMapXCategoryToOvertureConcepts(category).length,
      0,
    );
    expect(conceptCount).toBeLessThan(50);
  });
});
