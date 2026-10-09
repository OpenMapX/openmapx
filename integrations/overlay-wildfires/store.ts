import { createOverlayStore } from "@openmapx/core";

export type WildfireSourceId = "firms" | "nifc" | "effis" | "noaa-hms";

export interface WildfireSourceStatus {
  loading: boolean;
  fetchedAt: number | null;
  stale: boolean;
  truncated: boolean;
  error: "unavailable" | null;
  featureCount: number | null;
  /** The ids of the sources behind the layer's last response, for the credits and the legend. */
  sources: readonly string[];
}

const NO_SOURCES: readonly string[] = [];

function idleSourceStatus(): WildfireSourceStatus {
  return {
    loading: false,
    fetchedAt: null,
    stale: false,
    truncated: false,
    error: null,
    featureCount: null,
    sources: NO_SOURCES,
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
    dayRange: 1 as 1 | 2 | 3,
    source: "viirs" as "viirs" | "modis",
    showHotspots: true,
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
    showNoaaSmoke: false,
    showHeatmap: false,
    statuses: initialStatuses(),
  },
  actions: (set) => ({
    setDayRange: (dayRange: 1 | 2 | 3) => set({ dayRange }),
    setSource: (source: "viirs" | "modis") => set({ source }),
    setShowHotspots: (showHotspots: boolean) => set({ showHotspots }),
    setShowNifcPerimeters: (showNifcPerimeters: boolean) => set({ showNifcPerimeters }),
    setShowEffisBurnedAreas: (showEffisBurnedAreas: boolean) => set({ showEffisBurnedAreas }),
    setShowNoaaSmoke: (showNoaaSmoke: boolean) => set({ showNoaaSmoke }),
    setShowHeatmap: (showHeatmap: boolean) => set({ showHeatmap }),
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
