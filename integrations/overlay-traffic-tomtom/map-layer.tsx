"use client";

import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useStyleSyncedLayer } from "@/integration-api/map/useStyleSyncedLayer";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useTrafficStore } from "./store";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";

export function TrafficLayer() {
  const map = useMap();
  const { mapRef, mapReady, styleVersion } = map;
  const env = useEnv();
  // Declared in this integration's manifest (frontend.overlay.minZoom), the same
  // gate the layer selector applies — below it MapLibre requests no tiles.
  const minZoom = useOverlayMinZoom("traffic");
  const showTraffic = useTrafficStore((s) => s.panelOpen && s.layerVisible);
  useIntegrationAttribution("overlay-traffic-tomtom", showTraffic);

  useStyleSyncedLayer({
    map,
    visible: showTraffic,
    sourceId: TRAFFIC_SOURCE_ID,
    layerId: TRAFFIC_LAYER_ID,
    addSource: (m) => {
      m.addSource(TRAFFIC_SOURCE_ID, {
        type: "raster",
        tiles: [env.trafficTileUrlTemplate],
        tileSize: 256,
      });
    },
    addLayer: (m) => {
      addLayerInSlot(
        m,
        {
          id: TRAFFIC_LAYER_ID,
          type: "raster",
          source: TRAFFIC_SOURCE_ID,
          minzoom: minZoom,
          paint: {
            "raster-opacity": 0.9,
            "raster-fade-duration": 200,
          },
        },
        "raster-overlays",
        22,
      );
    },
    deps: [mapReady, styleVersion, mapRef, showTraffic, env.trafficTileUrlTemplate, minZoom],
  });

  return null;
}
