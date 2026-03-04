"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId, setLayerVisibility } from "./layerStyleUtils";

const TERRAIN_SOURCE_ID = "openmapx-terrain-source";
const TERRAIN_LAYER_ID = "openmapx-terrain-layer";

export function TerrainLayer() {
  const { mapRef, mapReady } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;
      const shouldShow = activeLayer === "terrain";

      if (shouldShow && !map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, {
          type: "raster",
          tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 17,
          attribution: "OpenTopoMap",
        });
      }

      if (shouldShow && !map.getLayer(TERRAIN_LAYER_ID)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: TERRAIN_LAYER_ID,
            type: "raster",
            source: TERRAIN_SOURCE_ID,
            paint: {
              "raster-opacity": 0.95,
              "raster-saturation": -0.15,
            },
          },
          beforeLayerId,
        );
      }

      setLayerVisibility(map, TERRAIN_LAYER_ID, shouldShow);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [activeLayer, mapReady, mapRef]);

  return null;
}
