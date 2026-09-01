"use client";

import { useSyncExternalStore } from "react";
import { subscribeOverlayStoreChanges } from "../stores/createOverlayStore";
import { isOverlayRegistryInitialized } from "../stores/overlayRegistry";

/**
 * True once the overlay registry has been populated from integration
 * metadata. The map is usually ready before `/api/integrations` resolves, so
 * anything that turns overlay ids into store actions at startup (deep links,
 * contextual automation) reads an empty registry if it runs on map readiness
 * alone; gate that work on this hook instead.
 */
export function useOverlayRegistryReady(): boolean {
  return useSyncExternalStore(
    subscribeOverlayStoreChanges,
    isOverlayRegistryInitialized,
    () => false,
  );
}
