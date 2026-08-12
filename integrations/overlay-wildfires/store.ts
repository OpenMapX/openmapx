import { createOverlayStore } from "@openmapx/core";

export type WildfireSourceId = "firms" | "nifc" | "effis" | "noaa-hms";

export interface WildfireSourceStatus {
  loading: boolean;
  fetchedAt: number | null;
  stale: boolean;
  truncated: boolean;
  error: "unavailable" | null;
  featureCount: number | null;
}

function idleSourceStatus(): WildfireSourceStatus {
  return {
    loading: false,
    fetchedAt: null,
    stale: false,
    truncated: false,
    error: null,
    featureCount: null,
  };
}

function initialStatuses(): Record<WildfireSourceId, WildfireSourceStatus> {
  return {
    firms: idleSourceStatus(),
    nifc: idleSourceStatus(),
    effis: idleSourceStatus(),
    "noaa-hms": idleSourceStatus(),
  };
}

export const useWildfireStore = createOverlayStore({
  overlayId: "wildfires",
  extra: {
    loading: false,
    dayRange: 1 as 1 | 2 | 3,
    source: "VIIRS_SNPP_NRT" as "VIIRS_SNPP_NRT" | "MODIS_NRT",
    showHotspots: true,
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
    showNoaaSmoke: false,
    showHeatmap: false,
    lastUpdated: null as number | null,
    statuses: initialStatuses(),
  },
  actions: (set) => ({
    setLoading: (loading: boolean) => set({ loading }),
    setDayRange: (dayRange: 1 | 2 | 3) => set({ dayRange }),
    setSource: (source: "VIIRS_SNPP_NRT" | "MODIS_NRT") => set({ source }),
    setShowHotspots: (showHotspots: boolean) => set({ showHotspots }),
    setShowNifcPerimeters: (showNifcPerimeters: boolean) => set({ showNifcPerimeters }),
    setShowEffisBurnedAreas: (showEffisBurnedAreas: boolean) => set({ showEffisBurnedAreas }),
    setShowNoaaSmoke: (showNoaaSmoke: boolean) => set({ showNoaaSmoke }),
    setShowHeatmap: (showHeatmap: boolean) => set({ showHeatmap }),
    setLastUpdated: (lastUpdated: number) => set({ lastUpdated }),
    setSourceStatus: (id: WildfireSourceId, patch: Partial<WildfireSourceStatus>) =>
      set((state) => ({
        statuses: {
          ...state.statuses,
          [id]: { ...state.statuses[id], ...patch },
        },
      })),
    resetSourceStatus: (id: WildfireSourceId) =>
      set((state) => ({
        statuses: {
          ...state.statuses,
          [id]: idleSourceStatus(),
        },
      })),
  }),
});
