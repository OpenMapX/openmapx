import { createOverlayStore } from "@openmapx/core";

export const useStreetViewStore = createOverlayStore({
  overlayId: "street-view",
  extra: { activeImageId: null as string | null },
  actions: (set) => ({
    setActiveImageId: (activeImageId: string | null) => set({ activeImageId }),
    closeViewer: () => set({ activeImageId: null }),
  }),
  onClose: () => ({ activeImageId: null }),
});
