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

/**
 * Reactively report whether any of the given overlays has its panel open — the
 * same condition each legend uses to decide whether to render (see
 * OverlayLegend). A single subscription across all listed stores keeps the hook
 * count stable regardless of how many overlays are passed, so the id list may
 * vary between renders. Resolving stores lazily mirrors `useOverlayStore`.
 */
export function useAnyOverlayPanelOpen(overlayIds: string[]): boolean {
  // Freeze the id list to a stable reference keyed by content, so the
  // subscribe/getSnapshot callbacks below only change when the ids actually do.
  const key = overlayIds.join(",");
  const ids = useMemo(() => key.split(",").filter(Boolean), [key]);

  const subscribe = useCallback(
    (cb: () => void) => {
      const unsubs = ids.map((id) => {
        const store =
          getRegisteredOverlayStore(id) ?? createOverlayStore({ overlayId: id, extra: {} });
        return store.subscribe(cb);
      });
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    [ids],
  );
  const getSnapshot = useCallback(
    () => ids.some((id) => getRegisteredOverlayStore(id)?.getState().panelOpen ?? false),
    [ids],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
