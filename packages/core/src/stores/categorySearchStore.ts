import { create } from "zustand";
import type { BrandSummary } from "../types/brand";
import type { CategoryId } from "../types/category";
import type { BoundingBox } from "../types/geometry";
import type { Place } from "../types/place";
import type { OverpassFilter } from "../utils/overpassFilter";
import { useCategoryFacetStore } from "./categoryFacetStore";
import { useOpeningHoursStore } from "./openingHoursStore";

/**
 * The `brand` facet (`packages/core/src/utils/categoryFacets.ts`) is written
 * by `nlpSearchStore.applyFacets` into the global facet store whenever an NLP
 * intent resolves a chain name to a `brand:wikidata` predicate. That
 * selection has no query scope of its own, so it must be cleared at every
 * point below that already resets ad-hoc search state — otherwise a resolved
 * chain search silently narrows the next unrelated search (no visible chip,
 * since the brand row only renders at 2+ brands; no panel badge, since the
 * facet is `placement: "inline"`).
 */
function clearBrandFacet(): void {
  useCategoryFacetStore.getState().clearFacets(["brand"]);
}

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
  /** The catalogued chain behind the current ad-hoc filter, when the filter came
   *  from a brand pick rather than an NLP parse. Drives the header card. */
  activeBrand: BrandSummary | null;
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
  setBrandFilter: (brand: BrandSummary, filter: OverpassFilter) => void;
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
  activeBrand: null,
  setActiveCategory: (activeCategory) => {
    clearBrandFacet();
    set({
      activeCategory,
      mode: "category",
      textQuery: "",
      adHocFilter: null,
      adHocLabel: null,
      activeBrand: null,
    });
  },
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
  setHoveredCategoryPlaceId: (hoveredCategoryPlaceId) => set({ hoveredCategoryPlaceId }),
  setAnchor: (anchor) => set({ anchor }),
  openExploreBox: (anchor) => set({ anchor, exploreBoxOpen: true }),
  closeExploreBox: () => set({ exploreBoxOpen: false }),
  setExploreText: (textQuery) => {
    clearBrandFacet();
    set({
      mode: "text",
      textQuery,
      activeCategory: null,
      adHocFilter: null,
      adHocLabel: null,
      activeBrand: null,
    });
  },
  setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
  setAdHocFilter: (adHocFilter, adHocLabel) => {
    clearBrandFacet();
    set({
      adHocFilter,
      adHocLabel,
      activeCategory: AD_HOC_CATEGORY_ID,
      mode: "category",
      textQuery: "",
      activeBrand: null,
    });
  },
  setBrandFilter: (brand, adHocFilter) =>
    set({
      adHocFilter,
      adHocLabel: brand.name,
      activeBrand: brand,
      mode: "category",
      activeCategory: AD_HOC_CATEGORY_ID,
      textQuery: "",
    }),
  clearCategory: () => {
    useOpeningHoursStore.getState().reset();
    clearBrandFacet();
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
      activeBrand: null,
    });
  },
}));
