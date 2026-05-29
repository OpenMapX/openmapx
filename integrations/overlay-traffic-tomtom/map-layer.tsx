"use client";

import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useStyleSyncedLayer } from "@/components/map/layers/useStyleSyncedLayer";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useTrafficStore } from "./store";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";

export function TrafficLayer() {
  const map = useMap();
  const { mapRef, mapReady, styleVersion } = map;
  const env = useEnv();
  const showTraffic = useTrafficStore((s) => s.panelOpen && s.layerVisible);
  useIntegrationAttribution("overlay-traffic-tomtom", showTraffic);
  useLayerReanchor(TRAFFIC_LAYER_ID, showTraffic);

  useStyleSyncedLayer({
    map,
    visible: showTraffic,
    sourceId: TRAFFIC_SOURCE_ID,
    layerId: TRAFFIC_LAYER_ID,
    moveBeforeFirstSymbol: true,
    addSource: (m) => {
      m.addSource(TRAFFIC_SOURCE_ID, {
        type: "raster",
        tiles: [env.trafficTileUrlTemplate],
        tileSize: 256,
      });
    },
    addLayer: (m, beforeLayerId) => {
      m.addLayer(
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
    },
    deps: [
      mapReady,
      styleVersion,
      mapRef,
      showTraffic,
      env.trafficTileUrlTemplate,
      env.trafficMinZoom,
    ],
  });

  return null;
}
