import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../types/place";
import { useCategorySearchStore } from "./categorySearchStore";

const place = { id: "p1", name: "Hbf", coordinates: [13.4, 52.5] } as unknown as Place;

describe("category hover publications", () => {
  beforeEach(() => useCategorySearchStore.setState({ hoveredCategoryPlaceId: null }));

  it.each([null, "osm:node/1"])("does not publish repeated hover value %s", (hoveredId) => {
    useCategorySearchStore.getState().setHoveredCategoryPlaceId(hoveredId);
    const original = useCategorySearchStore.getState();
    const listener = vi.fn();
    const unsubscribe = useCategorySearchStore.subscribe(listener);
    try {
      for (let index = 0; index < 100; index++) {
        useCategorySearchStore.getState().setHoveredCategoryPlaceId(hoveredId);
      }
      expect(listener).not.toHaveBeenCalled();
      expect(useCategorySearchStore.getState()).toBe(original);
    } finally {
      unsubscribe();
    }
  });

  it("publishes every real hover transition without changing search identity", () => {
    const revision = useCategorySearchStore.getState().searchRevision;
    const transitions: (string | null)[] = [];
    const unsubscribe = useCategorySearchStore.subscribe((state) => {
      transitions.push(state.hoveredCategoryPlaceId);
    });
    try {
      const store = useCategorySearchStore.getState();
      store.setHoveredCategoryPlaceId("osm:node/1");
      store.setHoveredCategoryPlaceId("osm:node/2");
      store.setHoveredCategoryPlaceId(null);
      expect(transitions).toEqual(["osm:node/1", "osm:node/2", null]);
      expect(useCategorySearchStore.getState().searchRevision).toBe(revision);
    } finally {
      unsubscribe();
    }
  });
});

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

  it("setAutoRefresh toggles autoRefresh", () => {
    expect(useCategorySearchStore.getState().autoRefresh).toBe(false);
    useCategorySearchStore.getState().setAutoRefresh(true);
    expect(useCategorySearchStore.getState().autoRefresh).toBe(true);
  });

  it("clearCategory resets autoRefresh to false", () => {
    useCategorySearchStore.getState().setAutoRefresh(true);
    useCategorySearchStore.getState().clearCategory();
    expect(useCategorySearchStore.getState().autoRefresh).toBe(false);
  });
});
