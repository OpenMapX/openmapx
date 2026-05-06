import { createOverlayStore } from "@openmapx/core";

export const useStreetViewStore = createOverlayStore({
  overlayId: "street-view",
  extra: {
    activeImageId: null as string | null,
    pendingImageId: null as string | null,
    mapillaryNoticeAccepted: false,
  },
  actions: (set) => ({
    requestImageLoad: (imageId: string) =>
      set((state) =>
        state.mapillaryNoticeAccepted
          ? { activeImageId: imageId, pendingImageId: null }
          : { pendingImageId: imageId },
      ),
    confirmPendingImageLoad: () =>
      set((state) =>
        state.pendingImageId
          ? {
              activeImageId: state.pendingImageId,
              pendingImageId: null,
              mapillaryNoticeAccepted: true,
            }
          : {},
      ),
    cancelPendingImageLoad: () => set({ pendingImageId: null }),
    closeViewer: () => set({ activeImageId: null, pendingImageId: null }),
  }),
  onClose: () => ({ activeImageId: null, pendingImageId: null }),
});
