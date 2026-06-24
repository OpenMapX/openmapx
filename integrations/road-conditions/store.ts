import { createOverlayStore } from "@openmapx/core";

/**
 * Overlay store for the road-conditions layer. No extra state — just the shared
 * `layerVisible`/`panelOpen` flags the layer selector toggles by overlay id.
 */
export const useRoadConditionsStore = createOverlayStore({
  overlayId: "road-conditions",
  extra: {},
});
