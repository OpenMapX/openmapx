"use client";

import type * as maplibregl from "maplibre-gl";
import { type DependencyList, useEffect } from "react";
import type { MapContextValue } from "@/lib/MapContext";
import { setLayerVisibility } from "./layerStyleUtils";

/**
 * Shared "style-synced overlay layer" effect.
 *
 * Encapsulates the recurring pattern used by single-source/single-layer raster
 * overlays: defer work until the style is loaded (re-running via `map.once("idle")`),
 * add the source/layer, toggle visibility, and keep everything in sync across
 * `styledata` events with proper listener cleanup.
 *
 * Behaviour is identical to the hand-written effect each overlay previously had:
 * the source is only added when `visible` is true and missing; the layer is only
 * added when `visible` is true and missing; visibility is always synced.
 *
 * Per-overlay variation is supplied via:
 *  - `sourceId` / `layerId`: the source and layer ids to manage.
 *  - `addSource(map)`: called to create the source (only when visible & absent).
 *  - `addLayer(map)`: called to create the layer (only when visible & absent).
 *    Callers place it with `addLayerInSlot` (the declared-slot registry decides
 *    depth now, not an insertion point this hook hands the caller).
 *  - `deps`: the effect dependency array (mirrors the original effect exactly).
 */
export function useStyleSyncedLayer(params: {
  map: MapContextValue;
  visible: boolean;
  sourceId: string;
  layerId: string;
  addSource: (map: maplibregl.Map) => void;
  addLayer: (map: maplibregl.Map) => void;
  deps: DependencyList;
}): void {
  const {
    map: { mapRef, mapReady, styleVersion },
    visible,
    sourceId,
    layerId,
    addSource,
    addLayer,
    deps,
  } = params;

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let idleRetryScheduled = false;
    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        if (idleRetryScheduled) map.off("idle", syncLayer);
        idleRetryScheduled = true;
        map.once("idle", syncLayer);
        return;
      }
      idleRetryScheduled = false;

      if (visible && !map.getSource(sourceId)) {
        addSource(map);
      }

      if (visible && !map.getLayer(layerId)) {
        addLayer(map);
      }

      setLayerVisibility(map, layerId, visible);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
      if (idleRetryScheduled) map.off("idle", syncLayer);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller to mirror each overlay's original effect dependency array exactly
  }, deps);
}
