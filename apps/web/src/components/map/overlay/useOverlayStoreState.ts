"use client";

import { getRegisteredOverlayStore, subscribeOverlayStoreChanges } from "@openmapx/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Overlay store instances are replaceable: a lazy-loaded map-layer's
 * module-scope `createOverlayStore({ overlayId })` overwrites whatever store
 * was auto-created for that id earlier (by `initOverlayRegistry` or a previous
 * lookup). Subscribing to a specific instance therefore goes stale — actions
 * like `toggleOverlay` always operate on the CURRENT registered instance. So
 * every hook here subscribes to the global overlay change signal (which every
 * instance, including replacements, feeds) and resolves the store fresh via
 * `getRegisteredOverlayStore` on each read. An unregistered store reads as
 * inactive.
 */
function useOverlayFlag(
  overlayId: string,
  select: (s: { layerVisible: boolean; panelOpen: boolean }) => boolean,
) {
  return useSyncExternalStore(
    subscribeOverlayStoreChanges,
    useCallback(() => {
      const store = getRegisteredOverlayStore(overlayId);
      return store ? select(store.getState()) : false;
    }, [overlayId, select]),
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
  return useCallback(
    (visible: boolean) => {
      getRegisteredOverlayStore(overlayId)?.getState().setLayerVisible(visible);
    },
    [overlayId],
  );
}

/**
 * Reactively report whether any of the given overlays has its panel open — the
 * same condition each legend uses to decide whether to render (see
 * OverlayLegend). The id list may vary between renders; it is frozen to a
 * content-keyed reference so the snapshot callback only changes when the ids
 * actually do.
 */
export function useAnyOverlayPanelOpen(overlayIds: string[]): boolean {
  const key = overlayIds.join(",");
  const ids = useMemo(() => key.split(",").filter(Boolean), [key]);

  const getSnapshot = useCallback(
    () => ids.some((id) => getRegisteredOverlayStore(id)?.getState().panelOpen ?? false),
    [ids],
  );
  return useSyncExternalStore(subscribeOverlayStoreChanges, getSnapshot, () => false);
}
