import { beforeEach, describe, expect, it } from "vitest";
import type { OverpassFilter } from "../../utils/overpassFilter";
import { AD_HOC_CATEGORY_ID, useCategorySearchStore } from "../categorySearchStore";
import { useOpeningHoursStore } from "../openingHoursStore";

const validFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
};

describe("useCategorySearchStore — ad-hoc filter", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
    useOpeningHoursStore.getState().reset();
  });

  describe("AD_HOC_CATEGORY_ID constant", () => {
    it("equals 'nlp:filter'", () => {
      expect(AD_HOC_CATEGORY_ID).toBe("nlp:filter");
    });
  });

  describe("setAdHocFilter", () => {
    it("sets adHocFilter and adHocLabel", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes nearby");
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBe(validFilter);
      expect(s.adHocLabel).toBe("Cafes nearby");
    });

    it("sets activeCategory to AD_HOC_CATEGORY_ID", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      expect(useCategorySearchStore.getState().activeCategory).toBe(AD_HOC_CATEGORY_ID);
    });

    it("sets mode to 'category' and clears textQuery", () => {
      useCategorySearchStore.getState().setExploreText("some text");
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      const s = useCategorySearchStore.getState();
      expect(s.mode).toBe("category");
      expect(s.textQuery).toBe("");
    });
  });

  describe("setActiveCategory clears ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel when selecting a real category", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setActiveCategory("cafes" as never);
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });

    it("nulls ad-hoc state when called with null", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setActiveCategory(null);
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });
  });

  describe("setExploreText clears ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel when entering text search", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().setExploreText("pizza near me");
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });
  });

  describe("clearCategory resets ad-hoc state", () => {
    it("nulls adHocFilter and adHocLabel", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().clearCategory();
      const s = useCategorySearchStore.getState();
      expect(s.adHocFilter).toBeNull();
      expect(s.adHocLabel).toBeNull();
    });

    it("also resets activeCategory to null", () => {
      useCategorySearchStore.getState().setAdHocFilter(validFilter, "Cafes");
      useCategorySearchStore.getState().clearCategory();
      expect(useCategorySearchStore.getState().activeCategory).toBeNull();
    });
  });
});
