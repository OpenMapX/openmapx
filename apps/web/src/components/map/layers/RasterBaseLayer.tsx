"use client";

import type { MapLayer } from "@openmapx/core";
import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { LayerSpecification } from "maplibre-gl";
import { useEffect } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { setLayerVisibility } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { addAttributedRasterSource } from "@/integration-api/overlay/rasterMapContribution";
import { useRasterMapAttributions } from "@/integration-api/overlay/useRasterMapAttributions";

type RasterPaint = Extract<LayerSpecification, { type: "raster" }>["paint"];

interface RasterBaseLayerProps {
  sourceId: string;
  layerId: string;
  tiles: string[];
  activeWhen: MapLayer;
  tileSize?: number;
  maxzoom?: number;
  /**
   * Capture the supplier at tile acquisition and credit retained painted tiles.
   */
  attributions: Attribution[];
  /** HTTP producer supplies the canonical receipt with each tile response. */
  receiptMode?: "uniform" | "response";
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
  receiptMode = "uniform",
  paint,
}: RasterBaseLayerProps) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const shouldShow = activeLayer === activeWhen;

  useRasterMapAttributions(
    `base-${sourceId}`,
    [{ sourceId, layerId, contributors: attributions }],
    shouldShow,
  );

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (tiles.length === 0) return;

      if (shouldShow && !map.getSource(sourceId)) {
        addAttributedRasterSource(
          map,
          sourceId,
          {
            type: "raster",
            tiles,
            tileSize,
            maxzoom,
          },
          attributions,
          receiptMode,
        );
      }

      if (shouldShow && !map.getLayer(layerId)) {
        addLayerInSlot(
          map,
          {
            id: layerId,
            type: "raster",
            source: sourceId,
            paint: paint ?? {},
          },
          "base-raster",
          0,
        );
      }

      setLayerVisibility(map, layerId, shouldShow);
    };

    return subscribeStyleLoaded(map, syncLayer);
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
    attributions,
    receiptMode,
  ]);

  return null;
}
