import { createOverlayStore, runOverlayTransaction, setOverlayLayerVisible } from "@openmapx/core";

export const BUILDING_TILT_THRESHOLD = 0.5;

interface MapPreference {
  panelOpen: boolean;
  layerVisible: boolean;
  cameraAutoEnableBlocked: boolean;
}

export const useBuildingsStore = createOverlayStore<
  { cameraAutoEnableBlocked: boolean; navigationPreference: MapPreference | null },
  {
    /**
     * Save the map's 3D state at trip start and restore it at trip end. A trip
     * starts flat unless `show3d` (the driver's remembered 3D navigation choice
     * for a driving trip); either way the panel closes.
     */
    syncNavigation: (active: boolean, options?: { show3d?: boolean }) => void;
    setCameraAutoEnableBlocked: (blocked: boolean) => void;
  }
>({
  overlayId: "3d-buildings",
  // Restored before the linked camera moves, even if the map layer is still lazy-loading.
  extra: { cameraAutoEnableBlocked: false, navigationPreference: null as MapPreference | null },
  actions: (set, get) => ({
    syncNavigation: (active, options = {}) => {
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
        // Turning only the layer on: a transaction with `panelOpen: true` would
        // open the 3D panel over the navigation view.
        if (options.show3d) {
          setOverlayLayerVisible("3d-buildings", true, {
            kind: "automation",
            owner: "3d-buildings-navigation",
          });
        }
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
