"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useStyleSyncedLayer } from "@/integration-api/map/useStyleSyncedLayer";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { MountainShelterLayer } from "./shelter-layer";
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
    addLayer: (m) => {
      addLayerInSlot(
        m,
        {
          id: RASTER_LAYER_ID,
          type: "raster",
          source: RASTER_SOURCE_ID,
          paint: {
            "raster-opacity": 0.85,
            "raster-fade-duration": 200,
          },
        },
        "raster-overlays",
        1,
      );
    },
    deps: [mapReady, styleVersion, mapRef, layerVisible, env.apiUrl],
  });

  return null;
}

export default function HikingMapLayer() {
  return (
    <>
      <HikingTrailsLayer />
      <MountainShelterLayer />
    </>
  );
}
