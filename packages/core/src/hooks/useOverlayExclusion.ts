import { useEffect, useRef } from "react";
import type { OverlayId } from "../stores/overlayRegistry";
import { closeExclusionPeers } from "../stores/overlayRegistry";

/**
 * Closes `overlayId`'s exclusion peers whenever its own layer turns visible.
 * This still calls closeExclusionPeers directly rather than through
 * runOverlayTransaction: it's an effect reacting to a visibility change that
 * already happened, not itself deciding to change anything, so there's
 * nothing to route through a transaction. When that visibility change came
 * from a contextual-automation transaction that already closed these same
 * peers, this fires again afterward but is a no-op — closeExclusionPeers only
 * calls closePanel() on a peer that's still open, so a peer already closed by
 * the transaction is left alone and its userRevision (and the automation
 * restore snapshot keyed on it) is never touched a second time.
 */
export function useOverlayExclusion(overlayId: OverlayId, layerVisible: boolean): void {
  const prevRef = useRef(false);

  useEffect(() => {
    if (layerVisible && !prevRef.current) {
      closeExclusionPeers(overlayId);
    }
    prevRef.current = layerVisible;
  }, [overlayId, layerVisible]);
}
