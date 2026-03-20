import { useEffect, useRef } from "react";
import type { OverlayId } from "../stores/overlayRegistry";
import { closeExclusionPeers } from "../stores/overlayRegistry";

export function useOverlayExclusion(overlayId: OverlayId, layerVisible: boolean): void {
  const prevRef = useRef(false);

  useEffect(() => {
    if (layerVisible && !prevRef.current) {
      closeExclusionPeers(overlayId);
    }
    prevRef.current = layerVisible;
  }, [overlayId, layerVisible]);
}
