"use client";

import { useEffect, useRef } from "react";
import type { MapContextValue } from "@/integration-api/map/MapContext";
import { removeSlottedLayers, unregisterLayerSlot } from "./layerStack";

export interface SlottedLayersToRemove {
  layerIds: readonly string[];
  sourceIds?: readonly string[];
}

/**
 * Remove an imperative overlay's layers and sources when it unmounts, for
 * example when its integration is disabled. Its reconciling effects cannot do
 * this in their own cleanup: they re-run on every dependency change, and a
 * teardown there would rebuild the overlay each time. `useMapLayerGroup`
 * already does this for declarative groups.
 *
 * `collect` is read at unmount, so it can list layers created dynamically.
 * When the map is already gone, only the slot registrations are released.
 */
export function useSlottedLayersCleanup(
  mapRef: MapContextValue["mapRef"],
  collect: () => SlottedLayersToRemove,
): void {
  // Both are read at unmount only; a changed identity must not run the cleanup.
  const latest = useRef({ collect, mapRef });
  latest.current = { collect, mapRef };

  useEffect(
    () => () => {
      const { layerIds, sourceIds } = latest.current.collect();
      const map = latest.current.mapRef.current;
      if (map) removeSlottedLayers(map, layerIds, sourceIds);
      else for (const id of layerIds) unregisterLayerSlot(id);
    },
    [],
  );
}
