import type { CategoryId } from "@integrations/poi-search/types";
import { create } from "zustand";
import type { BoundingBox } from "../types/geometry";
import type { Place } from "../types/place";
import { useOpeningHoursStore } from "./openingHoursStore";

interface CategorySearchState {
  activeCategory: CategoryId | null;
  searchBbox: BoundingBox | null;
  mapMoved: boolean;
  hoveredCategoryPlaceId: string | null;
  anchor: Place | null;
  exploreBoxOpen: boolean;
  setActiveCategory: (id: CategoryId | null) => void;
  setSearchBbox: (bbox: BoundingBox) => void;
  setMapMoved: (moved: boolean) => void;
  setHoveredCategoryPlaceId: (id: string | null) => void;
  setAnchor: (place: Place | null) => void;
  openExploreBox: (anchor: Place) => void;
  closeExploreBox: () => void;
  clearCategory: () => void;
}

export const useCategorySearchStore = create<CategorySearchState>((set) => ({
  activeCategory: null,
  searchBbox: null,
  mapMoved: false,
  hoveredCategoryPlaceId: null,
  anchor: null,
  exploreBoxOpen: false,
  setActiveCategory: (activeCategory) => set({ activeCategory }),
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
  setHoveredCategoryPlaceId: (hoveredCategoryPlaceId) => set({ hoveredCategoryPlaceId }),
  setAnchor: (anchor) => set({ anchor }),
  openExploreBox: (anchor) => set({ anchor, exploreBoxOpen: true }),
  closeExploreBox: () => set({ exploreBoxOpen: false }),
  clearCategory: () => {
    useOpeningHoursStore.getState().reset();
    set({
      activeCategory: null,
      searchBbox: null,
      mapMoved: false,
      hoveredCategoryPlaceId: null,
      anchor: null,
      exploreBoxOpen: false,
    });
  },
}));
