"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  getRegisteredOverlayStore,
  subscribeOverlayStoreChanges,
} from "../stores/createOverlayStore";

/**
 * Reactively report whether an overlay is active (panel open + layer visible).
 * Subscribes to the global overlay change signal and resolves the store fresh
 * on each read, so it stays correct when the overlay's store is registered
 * late or its instance is replaced by a lazy-loaded map-layer module.
 */
export function useIntegrationOverlayActive(integrationId: string): boolean {
  const getSnapshot = useCallback(() => {
    const store = getRegisteredOverlayStore(integrationId);
    if (!store) return false;
    const s = store.getState();
    return s.panelOpen && s.layerVisible;
  }, [integrationId]);

  return useSyncExternalStore(subscribeOverlayStoreChanges, getSnapshot, () => false);
}
