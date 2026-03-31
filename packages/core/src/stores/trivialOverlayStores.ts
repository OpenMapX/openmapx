/**
 * Auto-generated overlay stores for integrations that only need on/off state.
 *
 * Overlays with custom state (earthquakes, wildfires, hiking, etc.) still have
 * their own store files. These trivial stores are generated here to avoid
 * boilerplate files that only contain `createOverlayStore({ overlayId, extra: {} })`.
 */
import { createOverlayStore } from "./createOverlayStore";

export const useTrafficStore = createOverlayStore({ overlayId: "traffic", extra: {} });
export const useTransitStore = createOverlayStore({ overlayId: "transit", extra: {} });
export const useBuildingsStore = createOverlayStore({ overlayId: "3d-buildings", extra: {} });
