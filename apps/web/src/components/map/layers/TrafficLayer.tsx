"use client";

import { useTrafficStore } from "@openmapx/core";
import { useEffect } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import {
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "./layerStyleUtils";
import { useLayerReanchor } from "./useLayerReanchor";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";

export function TrafficLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const showTraffic = useTrafficStore((s) => s.panelOpen && s.layerVisible);
  useLayerReanchor(TRAFFIC_LAYER_ID, showTraffic);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;

      if (showTraffic && !map.getSource(TRAFFIC_SOURCE_ID)) {
        map.addSource(TRAFFIC_SOURCE_ID, {
          type: "raster",
          tiles: [env.trafficTileUrlTemplate],
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
            minzoom: env.trafficMinZoom,
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
  }, [mapReady, styleVersion, mapRef, showTraffic, env.trafficTileUrlTemplate, env.trafficMinZoom]);

  return null;
}
