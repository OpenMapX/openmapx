import { createOverlayStore } from "./createOverlayStore";

export const useEarthquakeStore = createOverlayStore({
  extra: {
    loading: false,
    timeRange: "week" as "hour" | "day" | "week" | "month",
    minMagnitude: 2.5,
    colorMode: "depth" as "depth" | "recency",
    showHeatmap: false,
    lastUpdated: null as number | null,
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setTimeRange: (timeRange: "hour" | "day" | "week" | "month") => set({ timeRange }),
    setMinMagnitude: (minMagnitude: number) => set({ minMagnitude }),
    setColorMode: (colorMode: "depth" | "recency") => set({ colorMode }),
    setShowHeatmap: (showHeatmap: boolean) => set({ showHeatmap }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
  }),
});
