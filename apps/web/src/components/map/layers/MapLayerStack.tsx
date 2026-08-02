"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { reportMissingLayers } from "@/lib/map/mapLayerDiagnostics";
import { findMissingLayers } from "./desiredStack";
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

  // A layer that should be drawing and is not looks exactly like a layer with
  // nothing to draw. `idle` is the cheapest moment to tell them apart: the style
  // has settled, so anything still absent is absent for a reason.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let last = 0;
    const check = () => {
      const now = performance.now();
      if (now - last < 2000) return;
      last = now;
      // Reported unconditionally, empty list included: that is what clears the
      // dedup set when a layer comes back, so a second disappearance is not
      // swallowed as already-reported.
      reportMissingLayers(findMissingLayers(map));
    };

    map.on("idle", check);
    return () => {
      map.off("idle", check);
    };
  }, [mapRef, mapReady]);

  return null;
}
