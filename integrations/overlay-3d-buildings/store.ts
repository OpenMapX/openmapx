import { createOverlayStore, runOverlayTransaction } from "@openmapx/core";

export const BUILDING_TILT_THRESHOLD = 0.5;

interface MapPreference {
  panelOpen: boolean;
  layerVisible: boolean;
  cameraAutoEnableBlocked: boolean;
}

export const useBuildingsStore = createOverlayStore<
  { cameraAutoEnableBlocked: boolean; navigationPreference: MapPreference | null },
  {
    syncNavigation: (active: boolean) => void;
    setCameraAutoEnableBlocked: (blocked: boolean) => void;
  }
>({
  overlayId: "3d-buildings",
  // Restored before the linked camera moves, even if the map layer is still lazy-loading.
  extra: { cameraAutoEnableBlocked: false, navigationPreference: null as MapPreference | null },
  actions: (set, get) => ({
    syncNavigation: (active: boolean) => {
      const state = get();
      if (active && !state.navigationPreference) {
        set({
          navigationPreference: {
            panelOpen: state.panelOpen,
            layerVisible: state.layerVisible,
            cameraAutoEnableBlocked: state.cameraAutoEnableBlocked,
          },
        });
        runOverlayTransaction(
          "3d-buildings",
          { panelOpen: false, layerVisible: false },
          { kind: "automation", owner: "3d-buildings-navigation" },
        );
      } else if (!active && state.navigationPreference) {
        const preference = state.navigationPreference;
        set({
          navigationPreference: null,
          cameraAutoEnableBlocked: preference.cameraAutoEnableBlocked,
        });
        runOverlayTransaction(
          "3d-buildings",
          {
            panelOpen: preference.panelOpen,
            layerVisible: preference.layerVisible,
          },
          { kind: "automation", owner: "3d-buildings-navigation" },
        );
      }
    },
    setCameraAutoEnableBlocked: (blocked: boolean) => set({ cameraAutoEnableBlocked: blocked }),
  }),
});
