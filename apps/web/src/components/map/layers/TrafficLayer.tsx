"use client";

import { useLayerStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import {
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "./layerStyleUtils";
import { getTrafficTileTemplate, TRAFFIC_MIN_ZOOM } from "./trafficConfig";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";

export function TrafficLayer() {
  const { mapRef, mapReady } = useMap();
  const showTraffic = useLayerStore((s) => s.showTraffic);
  const activeLayer = useLayerStore((s) => s.activeLayer);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;

      if (showTraffic && !map.getSource(TRAFFIC_SOURCE_ID)) {
        map.addSource(TRAFFIC_SOURCE_ID, {
          type: "raster",
          tiles: [getTrafficTileTemplate()],
          tileSize: 256,
          attribution:
            'Traffic data © <a href="https://developer.tomtom.com/" target="_blank">TomTom</a> (<a href="https://developer.tomtom.com/terms-and-conditions" target="_blank">Proprietary</a>)',
        });
      }

      if (showTraffic && !map.getLayer(TRAFFIC_LAYER_ID)) {
        const beforeLayerId = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: TRAFFIC_LAYER_ID,
            type: "raster",
            source: TRAFFIC_SOURCE_ID,
            minzoom: TRAFFIC_MIN_ZOOM,
            paint: {
              "raster-opacity": 0.9,
              "raster-fade-duration": 200,
            },
          },
          beforeLayerId,
        );
      }

      if (showTraffic) {
        moveLayerBeforeFirstSymbol(map, TRAFFIC_LAYER_ID);
      }

      setLayerVisibility(map, TRAFFIC_LAYER_ID, showTraffic);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, mapRef, showTraffic]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !showTraffic) return;

    // Re-anchor after base map changes (default/satellite/terrain).
    if (activeLayer !== "default" && activeLayer !== "satellite" && activeLayer !== "terrain") {
      return;
    }

    moveLayerBeforeFirstSymbol(map, TRAFFIC_LAYER_ID);
  }, [activeLayer, mapReady, mapRef, showTraffic]);

  return null;
}
