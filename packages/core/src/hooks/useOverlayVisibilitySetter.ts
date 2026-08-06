import { useCallback } from "react";
import type { OverlayId } from "../stores/overlayRegistry";
import { setOverlayLayerVisible } from "../stores/overlayRegistry";

/**
 * Stable setter for `overlayId`'s layer visibility, routed through
 * setOverlayLayerVisible with a `{kind: "user"}` origin. This is the
 * visibility-only counterpart to toggleOverlay: legend checkboxes and other
 * layer-only controls (Pegman, the street-level coverage switch) call this
 * instead of reaching into their own store's setLayerVisible directly, so the
 * write goes through the same origin-aware transaction boundary as every
 * panel-affecting overlay change, without touching panelOpen.
 */
export function useOverlayVisibilitySetter(overlayId: OverlayId): (visible: boolean) => void {
  return useCallback(
    (visible: boolean) => {
      setOverlayLayerVisible(overlayId, visible, { kind: "user" });
    },
    [overlayId],
  );
}
