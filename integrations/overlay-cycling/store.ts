import { createOverlayStore } from "@openmapx/core";

export const useCyclingStore = createOverlayStore({
  overlayId: "cycling",
  extra: { autoEnabled: false },
  actions: (set) => ({
    setAutoEnabled: (autoEnabled: boolean) => set({ autoEnabled }),
  }),
  onClose: () => ({ autoEnabled: false }),
});
