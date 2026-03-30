"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import type { OverlayStoreBase } from "../stores/createOverlayStore";

type OverlayStore = UseBoundStore<StoreApi<OverlayStoreBase>>;

const overlayStores = new Map<string, OverlayStore>();

export function registerOverlayStore(integrationId: string, store: OverlayStore): void {
  overlayStores.set(integrationId, store);
}

export function getOverlayStore(integrationId: string): OverlayStore | undefined {
  return overlayStores.get(integrationId);
}

export function useIntegrationOverlayActive(integrationId: string): boolean {
  const store = overlayStores.get(integrationId);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {};
      return store.subscribe(onStoreChange);
    },
    [store],
  );

  const getSnapshot = useCallback(() => {
    if (!store) return false;
    const s = store.getState();
    return s.panelOpen && s.layerVisible;
  }, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
