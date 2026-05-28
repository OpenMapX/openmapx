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

  it("setExploreText sets text mode and clears the active category", () => {
    const s = useCategorySearchStore.getState();
    s.setActiveCategory("restaurants" as never);
    s.setExploreText("vegan ramen");
    expect(useCategorySearchStore.getState().mode).toBe("text");
    expect(useCategorySearchStore.getState().textQuery).toBe("vegan ramen");
    expect(useCategorySearchStore.getState().activeCategory).toBeNull();
  });

  it("setActiveCategory resets mode to category", () => {
    const s = useCategorySearchStore.getState();
    s.setExploreText("vegan ramen");
    s.setActiveCategory("restaurants" as never);
    expect(useCategorySearchStore.getState().mode).toBe("category");
    expect(useCategorySearchStore.getState().textQuery).toBe("");
  });

  it("clearCategory resets mode and textQuery", () => {
    const s = useCategorySearchStore.getState();
    s.setExploreText("vegan ramen");
    s.clearCategory();
    expect(useCategorySearchStore.getState().mode).toBe("category");
    expect(useCategorySearchStore.getState().textQuery).toBe("");
  });
});
