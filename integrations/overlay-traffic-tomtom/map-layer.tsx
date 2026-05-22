"use client";

import { useEffect } from "react";
import {
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useTrafficStore } from "./store";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";

export function TrafficLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const showTraffic = useTrafficStore((s) => s.panelOpen && s.layerVisible);
  useIntegrationAttribution("overlay-traffic-tomtom", showTraffic);
  useLayerReanchor(TRAFFIC_LAYER_ID, showTraffic);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (showTraffic && !map.getSource(TRAFFIC_SOURCE_ID)) {
        map.addSource(TRAFFIC_SOURCE_ID, {
          type: "raster",
          tiles: [env.trafficTileUrlTemplate],
          tileSize: 256,
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
