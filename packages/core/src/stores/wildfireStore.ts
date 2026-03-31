import { createOverlayStore } from "./createOverlayStore";

export const useWildfireStore = createOverlayStore({
  overlayId: "wildfires",
  extra: {
    loading: false,
    dayRange: 1 as 1 | 2 | 3,
    source: "VIIRS_SNPP_NRT" as "VIIRS_SNPP_NRT" | "MODIS_NRT",
    showHeatmap: false,
    lastUpdated: null as number | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setDayRange: (dayRange: 1 | 2 | 3) => set({ dayRange }),
    setSource: (source: "VIIRS_SNPP_NRT" | "MODIS_NRT") => set({ source }),
    setShowHeatmap: (showHeatmap: boolean) => set({ showHeatmap }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
  }),
});
