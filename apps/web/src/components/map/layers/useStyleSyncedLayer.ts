"use client";

import type maplibregl from "maplibre-gl";
import { type DependencyList, useEffect } from "react";
import type { MapContextValue } from "@/lib/MapContext";
import {
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "./layerStyleUtils";

/**
 * Shared "style-synced overlay layer" effect.
 *
 * Encapsulates the recurring pattern used by single-source/single-layer raster
 * overlays: defer work until the style is loaded (re-running via `map.once("idle")`),
 * add the source/layer (inserting the layer before the first symbol layer),
 * optionally re-anchor the layer below symbols, toggle visibility, and keep
 * everything in sync across `styledata` events with proper listener cleanup.
 *
 * Behaviour is identical to the hand-written effect each overlay previously had:
 * the source is only added when `visible` is true and missing; the layer is only
 * added when `visible` is true and missing; visibility is always synced.
 *
 * Per-overlay variation is supplied via:
 *  - `sourceId` / `layerId`: the source and layer ids to manage.
 *  - `addSource(map)`: called to create the source (only when visible & absent).
 *  - `addLayer(map, beforeLayerId)`: called to create the layer (only when
 *    visible & absent), receiving the first-symbol-layer id to insert before.
 *  - `moveBeforeFirstSymbol`: when true, re-anchors the layer below the first
 *    symbol layer on every sync while visible.
 *  - `deps`: the effect dependency array (mirrors the original effect exactly).
 */
export function useStyleSyncedLayer(params: {
  map: MapContextValue;
  visible: boolean;
  sourceId: string;
  layerId: string;
  addSource: (map: maplibregl.Map) => void;
  addLayer: (map: maplibregl.Map, beforeLayerId: string | undefined) => void;
  moveBeforeFirstSymbol?: boolean;
  deps: DependencyList;
}): void {
  const {
    map: { mapRef, mapReady, styleVersion },
    visible,
    sourceId,
    layerId,
    addSource,
    addLayer,
    moveBeforeFirstSymbol = false,
    deps,
  } = params;

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (visible && !map.getSource(sourceId)) {
        addSource(map);
      }

      if (visible && !map.getLayer(layerId)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        addLayer(map, beforeLayerId);
      }

      if (visible && moveBeforeFirstSymbol) {
        moveLayerBeforeFirstSymbol(map, layerId);
      }

      setLayerVisibility(map, layerId, visible);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller to mirror each overlay's original effect dependency array exactly
  }, deps);
}
