import { beforeEach, describe, expect, it } from "vitest";
import type { BrandSummary } from "../../types/brand";
import { useCategorySearchStore } from "../categorySearchStore";

const aldi: BrandSummary = { qid: "Q41171", name: "Aldi", kind: ["brand"] };
const filter = {
  selectors: [{ tags: [{ key: "brand:wikidata", op: "=" as const, value: "Q41171" }] }],
};

describe("categorySearchStore brand state", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
  });

  it("sets the ad-hoc filter and the active brand together", () => {
    useCategorySearchStore.getState().setBrandFilter(aldi, filter);
    const state = useCategorySearchStore.getState();
    expect(state.activeBrand).toEqual(aldi);
    expect(state.adHocFilter).toEqual(filter);
    expect(state.adHocLabel).toBe("Aldi");
  });

  it("clears the active brand when a category is chosen", () => {
    useCategorySearchStore.getState().setBrandFilter(aldi, filter);
    useCategorySearchStore.getState().setActiveCategory("restaurants");
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
  });

  it("clears the active brand when a text search starts", () => {
    useCategorySearchStore.getState().setBrandFilter(aldi, filter);
    useCategorySearchStore.getState().setExploreText("pizza");
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
  });

  it("clears the active brand when an NLP ad-hoc filter replaces it", () => {
    useCategorySearchStore.getState().setBrandFilter(aldi, filter);
    useCategorySearchStore.getState().setAdHocFilter(filter, "open bakeries");
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
  });

  it("clears the active brand on clearCategory", () => {
    useCategorySearchStore.getState().setBrandFilter(aldi, filter);
    useCategorySearchStore.getState().clearCategory();
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
  });
});
