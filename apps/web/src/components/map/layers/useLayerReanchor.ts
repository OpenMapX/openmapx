"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { moveLayerBeforeFirstSymbol } from "./layerStyleUtils";

/**
 * Re-anchors map layers above the raster base layer when the active base map changes.
 * Without this, switching base layers (e.g. default → satellite) can place the raster
 * on top of custom overlay layers, visually hiding them.
 */
export function useLayerReanchor(layerIds: string | readonly string[], visible: boolean) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeLayer triggers layer re-ordering on base map switch
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !visible) return;

    const ids = typeof layerIds === "string" ? [layerIds] : layerIds;
    for (const id of ids) {
      moveLayerBeforeFirstSymbol(map, id);
    }
  }, [activeLayer, mapReady, styleVersion, mapRef, visible, layerIds]);
}
