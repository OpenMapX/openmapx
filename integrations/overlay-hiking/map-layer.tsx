"use client";

import {
  buildIntegrationAttribution,
  useIntegrationRegistry,
  useOverlayExclusion,
} from "@openmapx/core";
import { useEffect } from "react";
import { getFirstSymbolLayerId, setLayerVisibility } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useHikingStore } from "./store";

const RASTER_SOURCE_ID = "openmapx-hiking-trails-source";
const RASTER_LAYER_ID = "openmapx-hiking-trails-layer";

export function HikingTrailsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-hiking");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const layerVisible = useHikingStore((s) => s.layerVisible);
  useOverlayExclusion("hiking", layerVisible);
  useLayerReanchor(RASTER_LAYER_ID, layerVisible);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (layerVisible && !map.getSource(RASTER_SOURCE_ID)) {
        map.addSource(RASTER_SOURCE_ID, {
          type: "raster",
          tiles: [`${env.apiUrl}/api/integrations/overlay-hiking/tiles/{z}/{x}/{y}.png`],
          tileSize: 256,
          maxzoom: 18,
          attribution: attributionHtml,
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
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  return null;
}
