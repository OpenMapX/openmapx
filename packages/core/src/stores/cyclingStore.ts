import { createOverlayStore } from "./createOverlayStore";

export const useCyclingStore = createOverlayStore({
  extra: { autoEnabled: false },
  actions: (set) => ({
    setAutoEnabled: (autoEnabled: boolean) => set({ autoEnabled }),
  }),
  onClose: () => ({ autoEnabled: false }),
});
