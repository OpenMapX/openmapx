import { beforeEach, describe, expect, it } from "vitest";
import type { Place } from "../types/place";
import { useCategorySearchStore } from "./categorySearchStore";

const place = { id: "p1", name: "Hbf", coordinates: [13.4, 52.5] } as unknown as Place;

describe("categorySearchStore explore state", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
    useCategorySearchStore.setState({ exploreBoxOpen: false, anchor: null });
  });

  it("openExploreBox sets anchor and opens the box", () => {
    useCategorySearchStore.getState().openExploreBox(place);
    expect(useCategorySearchStore.getState().anchor).toBe(place);
    expect(useCategorySearchStore.getState().exploreBoxOpen).toBe(true);
  });

  it("closeExploreBox closes the box but keeps the anchor", () => {
    useCategorySearchStore.getState().openExploreBox(place);
    useCategorySearchStore.getState().closeExploreBox();
    expect(useCategorySearchStore.getState().exploreBoxOpen).toBe(false);
    expect(useCategorySearchStore.getState().anchor).toBe(place);
  });

  it("clearCategory resets anchor and box state", () => {
    useCategorySearchStore.getState().openExploreBox(place);
    useCategorySearchStore.getState().setActiveCategory("restaurants" as never);
    useCategorySearchStore.getState().clearCategory();
    expect(useCategorySearchStore.getState().anchor).toBeNull();
    expect(useCategorySearchStore.getState().exploreBoxOpen).toBe(false);
    expect(useCategorySearchStore.getState().activeCategory).toBeNull();
  });
});
