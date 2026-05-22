"use client";

import type { MapLayer } from "@openmapx/core";
import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { LayerSpecification } from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { useRegisterMapAttribution } from "@/lib/mapAttributionStore";
import { getFirstSymbolLayerId, setLayerVisibility } from "./layerStyleUtils";

type RasterPaint = Extract<LayerSpecification, { type: "raster" }>["paint"];

interface RasterBaseLayerProps {
  sourceId: string;
  layerId: string;
  tiles: string[];
  activeWhen: MapLayer;
  tileSize?: number;
  maxzoom?: number;
  /**
   * Attributions to register with the map's React-driven attribution strip
   * while this layer is the active base. No source-side `attribution` string
   * is set on MapLibre — the strip is the single rendering path.
   */
  attributions: Attribution[];
  paint?: RasterPaint;
}

export function RasterBaseLayer({
  sourceId,
  layerId,
  tiles,
  activeWhen,
  tileSize = 256,
  maxzoom = 20,
  attributions,
  paint,
}: RasterBaseLayerProps) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const shouldShow = activeLayer === activeWhen;

  // Only contribute to the attribution strip while this raster layer is the
  // active base. When inactive, an empty list effectively unregisters.
  useRegisterMapAttribution(`raster:${sourceId}`, shouldShow ? attributions : []);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        // `styledata` fires during loading (always with isStyleLoaded()=false)
        // but doesn't fire reliably once sources finish — register a one-shot
        // `idle` retry so this layer attaches after the map settles.
        map.once("idle", syncLayer);
        return;
      }

      if (tiles.length === 0) return;

      if (shouldShow && !map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster",
          tiles,
          tileSize,
          maxzoom,
        });
      }

      if (shouldShow && !map.getLayer(layerId)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: layerId,
            type: "raster",
            source: sourceId,
            paint: paint ?? {},
          },
          beforeLayerId,
        );
      }

      setLayerVisibility(map, layerId, shouldShow);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [
    shouldShow,
    mapReady,
    styleVersion,
    mapRef,
    sourceId,
    layerId,
    tiles,
    tileSize,
    maxzoom,
    paint,
  ]);

  return null;
}
