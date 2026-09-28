import { createOverlayStore } from "@openmapx/core";

export const BUILDING_TILT_THRESHOLD = 0.5;

export const useBuildingsStore = createOverlayStore({
  overlayId: "3d-buildings",
  // Restored before the linked camera moves, even if the map layer is still lazy-loading.
  extra: { cameraAutoEnableBlocked: false },
  actions: (set) => ({
    setCameraAutoEnableBlocked: (blocked: boolean) => set({ cameraAutoEnableBlocked: blocked }),
  }),
});
