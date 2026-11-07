import { describe, expect, it } from "vitest";
import {
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOvertureConcepts,
  overtureTaxonomyCategoryEvidence,
  overtureTaxonomyToOpenMapX,
} from "../overtureCategoryMap";

describe("Overture category interoperability bridge", () => {
  it("projects the retained requested category without changing global category selection", () => {
    const taxonomy = { basicCategory: "cafe", primary: "cafe", alternates: ["restaurant"] };
    expect(overtureTaxonomyToOpenMapX(taxonomy)).toBe("restaurants");
    expect(overtureTaxonomyCategoryEvidence(taxonomy, "cafes")).toEqual({
      category: "cafes",
      propertyPointers: ["/basic_category", "/taxonomy/primary"],
    });
    expect(overtureTaxonomyCategoryEvidence({ alternates: ["restaurant"] }, "cafes")).toEqual({
      propertyPointers: [],
    });
  });

  it("exposes supported UI categories with explicit cross-provider concept mappings", () => {
    expect(OVERTURE_COMMERCIAL_CATEGORIES).toContain("restaurants");
    expect(OVERTURE_COMMERCIAL_CATEGORIES).toContain("cafes");
    expect(OVERTURE_COMMERCIAL_CATEGORIES).not.toContain("drinking_water");
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
});
