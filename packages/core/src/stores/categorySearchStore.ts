import type { CategoryId } from "@integrations/poi-search/types";
import type { IsochroneTravelMode } from "@integrations/routing/types";
import { create } from "zustand";
import type { BoundingBox } from "../types/geometry";
import type { Place } from "../types/place";
import { useOpeningHoursStore } from "./openingHoursStore";

export interface TravelTimeConfig {
  enabled: boolean;
  mode: IsochroneTravelMode;
  minutes: number;
  onlyWithinReach: boolean;
}

const DEFAULT_TRAVEL_TIME: TravelTimeConfig = {
  enabled: false,
  mode: "walking",
  minutes: 15,
  onlyWithinReach: false,
};

interface CategorySearchState {
  activeCategory: CategoryId | null;
  searchBbox: BoundingBox | null;
  mapMoved: boolean;
  hoveredCategoryPlaceId: string | null;
  anchor: Place | null;
  exploreBoxOpen: boolean;
  mode: "category" | "text";
  textQuery: string;
  travelTime: TravelTimeConfig;
  setActiveCategory: (id: CategoryId | null) => void;
  setSearchBbox: (bbox: BoundingBox) => void;
  setMapMoved: (moved: boolean) => void;
  setHoveredCategoryPlaceId: (id: string | null) => void;
  setAnchor: (place: Place | null) => void;
  openExploreBox: (anchor: Place) => void;
  closeExploreBox: () => void;
  setExploreText: (query: string) => void;
  setTravelTime: (patch: Partial<TravelTimeConfig>) => void;
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
  travelTime: DEFAULT_TRAVEL_TIME,
  setActiveCategory: (activeCategory) => set({ activeCategory, mode: "category", textQuery: "" }),
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
  setHoveredCategoryPlaceId: (hoveredCategoryPlaceId) => set({ hoveredCategoryPlaceId }),
  setAnchor: (anchor) => set({ anchor }),
  openExploreBox: (anchor) => set({ anchor, exploreBoxOpen: true }),
  closeExploreBox: () => set({ exploreBoxOpen: false }),
  setExploreText: (textQuery) => set({ mode: "text", textQuery, activeCategory: null }),
  setTravelTime: (patch) => set((s) => ({ travelTime: { ...s.travelTime, ...patch } })),
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
      travelTime: DEFAULT_TRAVEL_TIME,
    });
  },
}));
