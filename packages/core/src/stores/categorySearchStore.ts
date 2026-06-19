import type { CategoryId } from "@integrations/poi-search/types";
import { create } from "zustand";
import type { BoundingBox } from "../types/geometry";
import type { Place } from "../types/place";
import type { OverpassFilter } from "../utils/overpassFilter";
import { useOpeningHoursStore } from "./openingHoursStore";

export const AD_HOC_CATEGORY_ID = "nlp:filter";

interface CategorySearchState {
  activeCategory: CategoryId | null;
  searchBbox: BoundingBox | null;
  mapMoved: boolean;
  hoveredCategoryPlaceId: string | null;
  anchor: Place | null;
  exploreBoxOpen: boolean;
  mode: "category" | "text";
  textQuery: string;
  autoRefresh: boolean;
  adHocFilter: OverpassFilter | null;
  adHocLabel: string | null;
  setActiveCategory: (id: CategoryId | null) => void;
  setSearchBbox: (bbox: BoundingBox) => void;
  setMapMoved: (moved: boolean) => void;
  setHoveredCategoryPlaceId: (id: string | null) => void;
  setAnchor: (place: Place | null) => void;
  openExploreBox: (anchor: Place) => void;
  closeExploreBox: () => void;
  setExploreText: (query: string) => void;
  setAutoRefresh: (autoRefresh: boolean) => void;
  setAdHocFilter: (filter: OverpassFilter, label: string) => void;
  clearCategory: () => void;
}

export const useCategorySearchStore = create<CategorySearchState>((set) => ({
  activeCategory: null,
  searchBbox: null,
  mapMoved: false,
  hoveredCategoryPlaceId: null,
  anchor: null,
  exploreBoxOpen: false,
  mode: "category",
  textQuery: "",
  autoRefresh: false,
  adHocFilter: null,
  adHocLabel: null,
  setActiveCategory: (activeCategory) =>
    set({ activeCategory, mode: "category", textQuery: "", adHocFilter: null, adHocLabel: null }),
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
  setHoveredCategoryPlaceId: (hoveredCategoryPlaceId) => set({ hoveredCategoryPlaceId }),
  setAnchor: (anchor) => set({ anchor }),
  openExploreBox: (anchor) => set({ anchor, exploreBoxOpen: true }),
  closeExploreBox: () => set({ exploreBoxOpen: false }),
  setExploreText: (textQuery) =>
    set({ mode: "text", textQuery, activeCategory: null, adHocFilter: null, adHocLabel: null }),
  setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
  setAdHocFilter: (adHocFilter, adHocLabel) =>
    set({
      adHocFilter,
      adHocLabel,
      activeCategory: AD_HOC_CATEGORY_ID,
      mode: "category",
      textQuery: "",
    }),
  clearCategory: () => {
    useOpeningHoursStore.getState().reset();
    set({
      activeCategory: null,
      searchBbox: null,
      mapMoved: false,
      hoveredCategoryPlaceId: null,
      anchor: null,
      exploreBoxOpen: false,
      mode: "category",
      textQuery: "",
      autoRefresh: false,
      adHocFilter: null,
      adHocLabel: null,
    });
  },
}));
