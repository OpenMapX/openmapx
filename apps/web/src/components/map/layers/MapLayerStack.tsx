"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { anchorMapLayers } from "./layerStack";

/**
 * Re-asserts the canonical layer order for the whole map. Every layer declares
 * its slot when it is created; this is the single place that repairs the stack
 * after the events that scramble it — a style swap, a basemap change, or two
 * create-effects landing in an unlucky order. Mounted once, next to the layers.
 */
export function MapLayerStack() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeLayer is the basemap-switch trigger, read only for its change
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const anchor = () => {
      anchorMapLayers(map);
    };
    anchor();
    map.on("styledata", anchor);
    map.on("idle", anchor);
    return () => {
      map.off("styledata", anchor);
      map.off("idle", anchor);
    };
  }, [mapRef, mapReady, styleVersion, activeLayer]);

  return null;
}
