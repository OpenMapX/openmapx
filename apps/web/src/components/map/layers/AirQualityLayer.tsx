"use client";

import { useAirQualityStore, useStreetViewStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId } from "./layerStyleUtils";

const AQ_SOURCE_ID = "waqi-air-quality";
const AQ_LAYER_ID = "air-quality-layer";

export function AirQualityLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const closePanel = useAirQualityStore((s) => s.closePanel);
  const svCoverageVisible = useStreetViewStore((s) => s.coverageVisible);

  // Mutual exclusion: close AQ whenever SV coverage turns on (covers Pegman + legend toggle)
  useEffect(() => {
    if (svCoverageVisible) closePanel();
  }, [svCoverageVisible, closePanel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

    const syncLayer = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(AQ_LAYER_ID)) map.removeLayer(AQ_LAYER_ID);
          if (map.getSource(AQ_SOURCE_ID)) map.removeSource(AQ_SOURCE_ID);
        } catch {
          // Tiles may still be in-flight when the source is torn down
        }
        return;
      }

      if (!map.isStyleLoaded()) return;

      if (!map.getSource(AQ_SOURCE_ID)) {
        map.addSource(AQ_SOURCE_ID, {
          type: "raster",
          tiles: [`${apiUrl}/api/air-quality/tiles/{z}/{x}/{y}.png`],
          tileSize: 256,
          attribution: '© <a href="https://waqi.info/" target="_blank">World Air Quality Index</a>',
        });
      }

      if (!map.getLayer(AQ_LAYER_ID)) {
        map.addLayer(
          {
            id: AQ_LAYER_ID,
            type: "raster",
            source: AQ_SOURCE_ID,
            paint: { "raster-opacity": 0.7 },
          },
          getFirstSymbolLayerId(map),
        );
      }
    };

    if (!layerVisible) {
      syncLayer();
      return;
    }

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, mapRef, layerVisible]);

  return null;
}
