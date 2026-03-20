import { createOverlayStore } from "./createOverlayStore";

export const useStreetViewStore = createOverlayStore({
  extra: { activeImageId: null as string | null },
  actions: (set) => ({
    setActiveImageId: (activeImageId: string | null) => set({ activeImageId }),
    closeViewer: () => set({ activeImageId: null }),
  }),
  onClose: () => ({ activeImageId: null }),
});
