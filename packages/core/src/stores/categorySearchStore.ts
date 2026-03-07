import { create } from "zustand";
import type { CategoryId } from "../types/category";
import type { BoundingBox } from "../types/geometry";

export type OpeningHoursFilter = "any" | "open_now" | "open_24h" | "open_at";

interface CategorySearchState {
  activeCategory: CategoryId | null;
  searchBbox: BoundingBox | null;
  mapMoved: boolean;
  hoveredCategoryPlaceId: string | null;
  openingHoursFilter: OpeningHoursFilter;
  /** JS day index (0=Sun … 6=Sat), null = any day. Only used for "open_at". */
  openAtDay: number | null;
  /** Hour 0-23, null = any time. Only used for "open_at". */
  openAtHour: number | null;
  setActiveCategory: (id: CategoryId | null) => void;
  setSearchBbox: (bbox: BoundingBox) => void;
  setMapMoved: (moved: boolean) => void;
  setHoveredCategoryPlaceId: (id: string | null) => void;
  setOpeningHoursFilter: (filter: OpeningHoursFilter) => void;
  setOpenAtFilter: (day: number | null, hour: number | null) => void;
  clearCategory: () => void;
}

export const useCategorySearchStore = create<CategorySearchState>((set) => ({
  activeCategory: null,
  searchBbox: null,
  mapMoved: false,
  hoveredCategoryPlaceId: null,
  openingHoursFilter: "any",
  openAtDay: null,
  openAtHour: null,
  setActiveCategory: (activeCategory) => set({ activeCategory }),
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
  setHoveredCategoryPlaceId: (hoveredCategoryPlaceId) => set({ hoveredCategoryPlaceId }),
  setOpeningHoursFilter: (openingHoursFilter) => set({ openingHoursFilter }),
  setOpenAtFilter: (openAtDay, openAtHour) =>
    set({ openingHoursFilter: "open_at", openAtDay, openAtHour }),
  clearCategory: () =>
    set({
      activeCategory: null,
      searchBbox: null,
      mapMoved: false,
      hoveredCategoryPlaceId: null,
      openingHoursFilter: "any",
      openAtDay: null,
      openAtHour: null,
    }),
}));
