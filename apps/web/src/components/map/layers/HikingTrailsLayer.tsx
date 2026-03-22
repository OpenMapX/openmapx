"use client";

import { useHikingStore, useOverlayExclusion } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId, setLayerVisibility } from "./layerStyleUtils";
import { useLayerReanchor } from "./useLayerReanchor";

const RASTER_SOURCE_ID = "openmapx-hiking-trails-source";
const RASTER_LAYER_ID = "openmapx-hiking-trails-layer";

export function HikingTrailsLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useHikingStore((s) => s.layerVisible);
  useOverlayExclusion("hiking", layerVisible);
  useLayerReanchor(RASTER_LAYER_ID, layerVisible);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;

      if (layerVisible && !map.getSource(RASTER_SOURCE_ID)) {
        map.addSource(RASTER_SOURCE_ID, {
          type: "raster",
          tiles: ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 18,
          attribution:
            '© <a href="https://hiking.waymarkedtrails.org" target="_blank">Waymarked Trails</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank">CC BY-SA 3.0</a>)',
        });
      }

      if (layerVisible && !map.getLayer(RASTER_LAYER_ID)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: RASTER_LAYER_ID,
            type: "raster",
            source: RASTER_SOURCE_ID,
            paint: {
              "raster-opacity": 0.85,
              "raster-fade-duration": 200,
            },
          },
          beforeLayerId,
        );
      }

      setLayerVisibility(map, RASTER_LAYER_ID, layerVisible);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, mapRef, layerVisible]);

  return null;
}
