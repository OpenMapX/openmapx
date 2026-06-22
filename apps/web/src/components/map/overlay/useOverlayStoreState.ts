"use client";

import { createOverlayStore, getRegisteredOverlayStore } from "@openmapx/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Resolve the overlay store for an id, creating + registering it if it doesn't
 * exist yet. `initOverlayRegistry` auto-creates declarative overlays' stores in
 * an effect that runs AFTER the map/legend hosts first render, so resolving the
 * store lazily here (memoized per id) avoids a race where the hooks would
 * subscribe to an absent store and never observe the toggle. Idempotent:
 * `initOverlayRegistry`/`toggleOverlay` then find this same instance.
 */
function useOverlayStore(overlayId: string) {
  return useMemo(
    () => getRegisteredOverlayStore(overlayId) ?? createOverlayStore({ overlayId, extra: {} }),
    [overlayId],
  );
}

function useOverlayFlag(
  overlayId: string,
  select: (s: { layerVisible: boolean; panelOpen: boolean }) => boolean,
) {
  const store = useOverlayStore(overlayId);
  return useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb), [store]),
    useCallback(() => select(store.getState()), [store, select]),
    () => false,
  );
}

const selectLayerVisible = (s: { layerVisible: boolean }) => s.layerVisible;
const selectPanelOpen = (s: { panelOpen: boolean }) => s.panelOpen;

export function useOverlayLayerVisible(overlayId: string): boolean {
  return useOverlayFlag(overlayId, selectLayerVisible);
}

export function useOverlayPanelOpen(overlayId: string): boolean {
  return useOverlayFlag(overlayId, selectPanelOpen);
}

export function useOverlaySetLayerVisible(overlayId: string): (visible: boolean) => void {
  return useOverlayStore(overlayId).getState().setLayerVisible;
}
