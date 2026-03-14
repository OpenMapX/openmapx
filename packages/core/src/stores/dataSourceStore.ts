import { create } from "zustand";
import type { BoundingBox } from "../types/geometry";

interface DataSourceState {
  activeSource: string | null;
  filters: Record<string, unknown>;
  selectedItem: { sourceId: string; itemId: string } | null;
  viewportBbox: BoundingBox | null;
  viewportZoom: number;
  /** The bbox used for the actual search query. Only updated on initial activation or "Search in this area". */
  searchBbox: BoundingBox | null;
  /** True when the map has moved since the last search. */
  mapMoved: boolean;

  setActiveSource: (id: string | null) => void;
  toggleSource: (id: string) => void;
  setFilter: (filterId: string, value: unknown) => void;
  clearFilters: () => void;
  selectItem: (sourceId: string, itemId: string) => void;
  clearSelection: () => void;
  setViewport: (bbox: BoundingBox, zoom: number) => void;
  setSearchBbox: (bbox: BoundingBox) => void;
  setMapMoved: (moved: boolean) => void;
}

export const useDataSourceStore = create<DataSourceState>((set) => ({
  activeSource: null,
  filters: {},
  selectedItem: null,
  viewportBbox: null,
  viewportZoom: 0,
  searchBbox: null,
  mapMoved: false,

  setActiveSource: (id) =>
    set({ activeSource: id, filters: {}, selectedItem: null, searchBbox: null, mapMoved: false }),
  toggleSource: (id) =>
    set((state) =>
      state.activeSource === id
        ? { activeSource: null, filters: {}, selectedItem: null, searchBbox: null, mapMoved: false }
        : { activeSource: id, filters: {}, selectedItem: null, searchBbox: null, mapMoved: false },
    ),
  setFilter: (filterId, value) =>
    set((state) => ({ filters: { ...state.filters, [filterId]: value } })),
  clearFilters: () => set({ filters: {} }),
  selectItem: (sourceId, itemId) => set({ selectedItem: { sourceId, itemId } }),
  clearSelection: () => set({ selectedItem: null }),
  setViewport: (bbox, zoom) => set({ viewportBbox: bbox, viewportZoom: zoom }),
  setSearchBbox: (searchBbox) => set({ searchBbox }),
  setMapMoved: (mapMoved) => set({ mapMoved }),
}));
