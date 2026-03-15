"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId, setLayerVisibility } from "./layerStyleUtils";

const SATELLITE_SOURCE_ID = "openmapx-satellite-source";
const SATELLITE_LAYER_ID = "openmapx-satellite-layer";

export function SatelliteLayer() {
  const { mapRef, mapReady } = useMap();
  const activeLayer = useLayerStore((s) => s.activeLayer);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;
      const shouldShow = activeLayer === "satellite";

      const apiKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
      if (!apiKey) return;

      if (shouldShow && !map.getSource(SATELLITE_SOURCE_ID)) {
        map.addSource(SATELLITE_SOURCE_ID, {
          type: "raster",
          tiles: [`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${apiKey}`],
          tileSize: 256,
          maxzoom: 20,
          attribution:
            '© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> (<a href="https://www.maptiler.com/copyright/" target="_blank">Proprietary</a>)',
        });
      }

      if (shouldShow && !map.getLayer(SATELLITE_LAYER_ID)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: SATELLITE_LAYER_ID,
            type: "raster",
            source: SATELLITE_SOURCE_ID,
            paint: {
              "raster-opacity": 1,
            },
          },
          beforeLayerId,
        );
      }

      setLayerVisibility(map, SATELLITE_LAYER_ID, shouldShow);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [activeLayer, mapReady, mapRef]);

  return null;
}
