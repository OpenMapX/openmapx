import { createOverlayStore } from "@openmapx/core";

/**
 * Overlay store for the colored traffic-flow layer. Filtering happens
 * client-side in the MapLibre paint expressions, not via a fetched/filtered
 * dataset, so the only extra state is whether the tiles can be loaded at all.
 */
export const useTrafficFlowStore = createOverlayStore({
  overlayId: "traffic-flow",
  extra: {
    /** The tile source is missing or failing: an empty map is not free-flowing traffic. */
    unavailable: false,
  },
  actions: (set) => ({
    setUnavailable: (unavailable: boolean) => set({ unavailable }),
  }),
});
