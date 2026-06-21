import { describe, expect, it } from "vitest";
import {
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOverture,
  openmapxCategoryToOvertureLeaves,
  overtureCategoryToOpenMapX,
} from "../overtureCategoryMap";

// OSM-only (non-commercial) CategoryIds that should NOT have Overture mappings
const OSM_ONLY_CATEGORIES = ["drinking_water", "viewpoints", "aeds"] as const;

describe("OVERTURE_COMMERCIAL_CATEGORIES", () => {
  it("is a non-empty array", () => {
    expect(OVERTURE_COMMERCIAL_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("does not include OSM-only categories", () => {
    for (const cat of OSM_ONLY_CATEGORIES) {
      expect(OVERTURE_COMMERCIAL_CATEGORIES).not.toContain(cat);
    }
  });
});

describe("openmapxCategoryToOvertureLeaves — commercial categories map to leaves", () => {
  for (const cat of OVERTURE_COMMERCIAL_CATEGORIES) {
    it(`"${cat}" resolves to at least one Overture leaf`, () => {
      const leaves = openmapxCategoryToOvertureLeaves(cat);
      expect(leaves.length).toBeGreaterThan(0);
    });
  }
});

describe("overtureCategoryToOpenMapX — every commercial leaf maps back", () => {
  for (const cat of OVERTURE_COMMERCIAL_CATEGORIES) {
    const leaves = openmapxCategoryToOvertureLeaves(cat);
    for (const leaf of leaves) {
      it(`"${leaf}" (from "${cat}") maps back to a non-null CategoryId`, () => {
        const mapped = overtureCategoryToOpenMapX(leaf);
        expect(mapped).toBeDefined();
        expect(typeof mapped).toBe("string");
      });
    }
  }
});

describe("openMapXCategoryToOverture — commercial categories have mappings", () => {
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

  it("'dentist' maps to 'dentists'", () => {
    expect(overtureCategoryToOpenMapX("dentist")).toBe("dentists");
  });

  it("'doctor' maps to 'doctors'", () => {
    expect(overtureCategoryToOpenMapX("doctor")).toBe("doctors");
  });

  it("'train_station' maps to 'transit'", () => {
    expect(overtureCategoryToOpenMapX("train_station")).toBe("transit");
  });

  it("'supermarket' maps to 'supermarkets'", () => {
    expect(overtureCategoryToOpenMapX("supermarket")).toBe("supermarkets");
  });

  it("office/professional categories with no OpenMapX analog stay unmapped", () => {
    expect(overtureCategoryToOpenMapX("professional_services")).toBeUndefined();
    expect(overtureCategoryToOpenMapX("advertising_agency")).toBeUndefined();
  });

  it("unknown leaf returns undefined", () => {
    expect(overtureCategoryToOpenMapX("definitely_not_a_category")).toBeUndefined();
  });

  it("empty string returns undefined", () => {
    expect(overtureCategoryToOpenMapX("")).toBeUndefined();
  });

  it("covers the bridged Overture taxonomy breadth (>=400 leaves)", () => {
    const total = OVERTURE_COMMERCIAL_CATEGORIES.reduce(
      (n, cat) => n + openmapxCategoryToOvertureLeaves(cat).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(400);
  });
});
