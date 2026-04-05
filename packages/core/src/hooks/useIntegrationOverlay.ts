"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import type { OverlayStoreBase } from "../stores/createOverlayStore";
import { getRegisteredOverlayStore } from "../stores/createOverlayStore";

type OverlayStore = UseBoundStore<StoreApi<OverlayStoreBase>>;

export function useIntegrationOverlayActive(integrationId: string): boolean {
  const store = getRegisteredOverlayStore(integrationId) as OverlayStore | undefined;

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
