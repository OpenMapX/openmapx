"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useStyleSyncedLayer } from "@/components/map/layers/useStyleSyncedLayer";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useHikingStore } from "./store";

const RASTER_SOURCE_ID = "openmapx-hiking-trails-source";
const RASTER_LAYER_ID = "openmapx-hiking-trails-layer";

export function HikingTrailsLayer() {
  const map = useMap();
  const { mapRef, mapReady, styleVersion } = map;
  const env = useEnv();
  const layerVisible = useHikingStore((s) => s.layerVisible);
  useIntegrationAttribution("overlay-hiking", layerVisible);
  useOverlayExclusion("hiking", layerVisible);
  useLayerReanchor(RASTER_LAYER_ID, layerVisible);

  useStyleSyncedLayer({
    map,
    visible: layerVisible,
    sourceId: RASTER_SOURCE_ID,
    layerId: RASTER_LAYER_ID,
    addSource: (m) => {
      m.addSource(RASTER_SOURCE_ID, {
        type: "raster",
        tiles: [`${env.apiUrl}/api/integrations/overlay-hiking/tiles/{z}/{x}/{y}.png`],
        tileSize: 256,
        maxzoom: 18,
      });
    },
    addLayer: (m, beforeLayerId) => {
      m.addLayer(
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
    },
    deps: [mapReady, styleVersion, mapRef, layerVisible, env.apiUrl],
  });

  return null;
}
