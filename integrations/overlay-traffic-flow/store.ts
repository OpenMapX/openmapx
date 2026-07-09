import { createOverlayStore } from "@openmapx/core";

/**
 * Overlay store for the colored traffic-flow layer. No extra state beyond the
 * shared `layerVisible`/`panelOpen` flags — filtering happens client-side in
 * the MapLibre paint expressions, not via a fetched/filtered dataset.
 */
export const useTrafficFlowStore = createOverlayStore({ overlayId: "traffic-flow", extra: {} });
