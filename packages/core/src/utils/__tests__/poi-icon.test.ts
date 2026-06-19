import { describe, expect, it } from "vitest";
import { AD_HOC_ICON_PATH, poiCategoryIconPath } from "../poi-icon";

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
