import { describe, expect, it } from "vitest";
import { AD_HOC_ICON_PATH, poiCategoryIconPath, resolvePoiCategoryId } from "../poi-icon";

describe("poiCategoryIconPath", () => {
  it("returns the known iconPath for a real category", () => {
    const path = poiCategoryIconPath("restaurants");
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
    // Should be the MUI restaurant icon path (starts with the known svg d value)
    expect(path).toContain("M11 9H9V2H7v7H5V2H3v7");
  });

  it("returns AD_HOC_ICON_PATH for the sentinel nlp:filter id", () => {
    expect(poiCategoryIconPath("nlp:filter")).toBe(AD_HOC_ICON_PATH);
  });

  it("returns AD_HOC_ICON_PATH for an arbitrary unknown category id", () => {
    expect(poiCategoryIconPath("totally_unknown_category_xyz")).toBe(AD_HOC_ICON_PATH);
  });

  it("AD_HOC_ICON_PATH is a non-empty string", () => {
    expect(typeof AD_HOC_ICON_PATH).toBe("string");
    expect(AD_HOC_ICON_PATH.length).toBeGreaterThan(0);
  });
});

describe("resolvePoiCategoryId", () => {
  it("maps raw provider and OSM categories onto category ids", () => {
    expect(resolvePoiCategoryId("restaurant")).toBe("restaurants");
    expect(resolvePoiCategoryId("Coffee Shop")).toBe("cafes");
    expect(resolvePoiCategoryId("fast-food")).toBe("restaurants");
  });

  it("falls back to the head word of a qualified category", () => {
    expect(resolvePoiCategoryId("vegan_restaurant")).toBe("restaurants");
    expect(resolvePoiCategoryId("wine_bar")).toBe("bars");
  });

  it("returns undefined for a category it does not know", () => {
    expect(resolvePoiCategoryId("")).toBeUndefined();
    expect(resolvePoiCategoryId("bus_station")).toBeUndefined();
  });
});
