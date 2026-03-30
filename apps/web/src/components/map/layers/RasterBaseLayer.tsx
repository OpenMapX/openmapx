"use client";

import type { MapLayer } from "@openmapx/core";
import { useLayerStore } from "@openmapx/core";
import type { LayerSpecification } from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId, setLayerVisibility } from "./layerStyleUtils";

type RasterPaint = Extract<LayerSpecification, { type: "raster" }>["paint"];

interface RasterBaseLayerProps {
  sourceId: string;
  layerId: string;
  tiles: string[];
  activeWhen: MapLayer;
  tileSize?: number;
  maxzoom?: number;
  attribution: string;
  paint?: RasterPaint;
}

export function RasterBaseLayer({
  sourceId,
  layerId,
  tiles,
  activeWhen,
  tileSize = 256,
  maxzoom = 20,
  attribution,
  paint,
}: RasterBaseLayerProps) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;
      const shouldShow = activeLayer === activeWhen;

      if (tiles.length === 0) return;

      const existingSource = map.getSource(sourceId);
      if (shouldShow && existingSource) {
        const current = (existingSource as { attribution?: string }).attribution;
        if (current !== attribution) {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
          map.removeSource(sourceId);
        }
      }

      if (shouldShow && !map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster",
          tiles,
          tileSize,
          maxzoom,
          attribution,
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
    activeLayer,
    activeWhen,
    mapReady,
    styleVersion,
    mapRef,
    sourceId,
    layerId,
    tiles,
    tileSize,
    maxzoom,
    attribution,
    paint,
  ]);

  return null;
}
