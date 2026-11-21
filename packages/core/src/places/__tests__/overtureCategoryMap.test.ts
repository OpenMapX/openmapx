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
      "tea_room",
      "tea_house",
    ]);
    expect(openMapXCategoryToOvertureConcepts("drinking_water")).toEqual([]);
  });

  it("matches current Overture 2026-09-23 taxonomy concepts and retains pre-rename fallbacks", () => {
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "rental_service",
        primary: "car_rental_service",
        hierarchy: [
          "services_and_business",
          "rental_service",
          "vehicle_rental_service",
          "car_rental_service",
        ],
      }),
    ).toBe("car_rental");
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "automotive_service",
        primary: "brake_service_and_repair",
        hierarchy: [
          "travel_and_transportation",
          "vehicle_service",
          "automotive_service",
          "automotive_repair",
          "brake_service_and_repair",
        ],
      }),
    ).toBe("car_repair");
    expect(overtureTaxonomyToOpenMapX({ basicCategory: "auto_repair_service" })).toBe("car_repair");
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "diagnostics_imaging_or_lab_service",
        primary: "doctors_office",
        hierarchy: [
          "health_care",
          "outpatient_care_facility",
          "diagnostics_imaging_or_lab_service",
          "doctors_office",
        ],
      }),
    ).toBe("doctors");
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "primary_care_or_general_clinic",
        primary: "family_practice",
        hierarchy: [
          "health_care",
          "outpatient_care_facility",
          "primary_care_or_general_clinic",
          "family_practice",
        ],
      }),
    ).toBe("doctors");
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "dental_clinic",
        primary: "general_dentistry",
        hierarchy: [
          "health_care",
          "outpatient_care_facility",
          "dental_clinic",
          "general_dentistry",
        ],
      }),
    ).toBe("dentists");
    expect(
      overtureTaxonomyToOpenMapX({
        basicCategory: "personal_or_beauty_service",
        primary: "barber",
        hierarchy: ["lifestyle_services", "personal_or_beauty_service", "barber"],
      }),
    ).toBe("hairdressers");
    expect(overtureTaxonomyToOpenMapX({ primary: "beauty_salon" })).toBe("hairdressers");
    expect(overtureTaxonomyToOpenMapX({ primary: "fitness_studio" })).toBe("gyms");
    expect(overtureTaxonomyToOpenMapX({ primary: "tea_room" })).toBe("cafes");
    expect(overtureTaxonomyToOpenMapX({ primary: "beer_garden" })).toBe("bars");
    expect(overtureTaxonomyToOpenMapX({ primary: "optometry" })).toBe("opticians");
    expect(overtureTaxonomyToOpenMapX({ primary: "veterinary_care" })).toBe("veterinarians");
    expect(overtureTaxonomyToOpenMapX({ primary: "bank_or_credit_union" })).toBe("banks");
    expect(overtureTaxonomyToOpenMapX({ primary: "patisserie_cake_shop" })).toBe("bakeries");
    expect(overtureTaxonomyToOpenMapX({ primary: "department_store" })).toBe("shopping_malls");
    expect(overtureTaxonomyToOpenMapX({ primary: "nightlife_venue" })).toBe("nightlife");
    // Broad medical specialties parent stays out of doctors (contains tattoo_removal, etc.).
    expect(
      overtureTaxonomyToOpenMapX({
        primary: "tattoo_removal",
        hierarchy: [
          "health_care",
          "outpatient_care_facility",
          "specialized_health_care",
          "medical_skin_care",
          "tattoo_removal",
        ],
      }),
    ).toBeUndefined();
    // Pre-Sep 2026 terms still resolve for older snapshots.
    expect(overtureTaxonomyToOpenMapX({ primary: "dentist" })).toBe("dentists");
    expect(overtureTaxonomyToOpenMapX({ primary: "doctor" })).toBe("doctors");
    expect(overtureTaxonomyToOpenMapX({ primary: "car_rental" })).toBe("car_rental");
    expect(overtureTaxonomyToOpenMapX({ primary: "barber_shop" })).toBe("hairdressers");
    expect(overtureTaxonomyToOpenMapX({ primary: "tea_house" })).toBe("cafes");
    expect(overtureTaxonomyToOpenMapX({ primary: "supermarket" })).toBe("supermarkets");
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
