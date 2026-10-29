"use client";

import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useStyleSyncedLayer } from "@/integration-api/map/useStyleSyncedLayer";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { addAttributedRasterSource } from "@/integration-api/overlay/rasterMapContribution";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useRasterMapAttributions } from "@/integration-api/overlay/useRasterMapAttributions";
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
  const resolve = useContributorResolver();
  useRasterMapAttributions(
    "traffic",
    [
      {
        sourceId: TRAFFIC_SOURCE_ID,
        layerId: TRAFFIC_LAYER_ID,
        contributors: resolve({ sourceIds: ["tomtom"] }),
      },
    ],
    showTraffic,
  );

  useStyleSyncedLayer({
    map,
    visible: showTraffic,
    sourceId: TRAFFIC_SOURCE_ID,
    layerId: TRAFFIC_LAYER_ID,
    addSource: (m) => {
      addAttributedRasterSource(
        m,
        TRAFFIC_SOURCE_ID,
        {
          type: "raster",
          tiles: [env.trafficTileUrlTemplate],
          tileSize: 256,
        },
        resolve({ sourceIds: ["tomtom"] }),
      );
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
