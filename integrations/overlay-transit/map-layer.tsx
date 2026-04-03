"use client";

import { useEffect } from "react";
import {
  findVectorLineReference,
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";
import { useTransitStore } from "./store";

const TRANSIT_LAYER_ID = "openmapx-transit-layer";
const TRANSIT_LAYER_HINTS = [
  /rail/i,
  /transit/i,
  /tram/i,
  /subway/i,
  /bus/i,
  /transport/i,
] as const;

export function TransitLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const showTransit = useTransitStore((s) => s.panelOpen && s.layerVisible);
  useLayerReanchor(TRANSIT_LAYER_ID, showTransit);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;

      if (showTransit && !map.getLayer(TRANSIT_LAYER_ID)) {
        const reference = findVectorLineReference(map, TRANSIT_LAYER_HINTS);
        if (reference) {
          const beforeLayerId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: TRANSIT_LAYER_ID,
              type: "line",
              source: reference.source,
              "source-layer": reference.sourceLayer,
              filter: ["in", "class", "transit", "rail", "subway", "tram", "bus", "ferry", "train"],
              paint: {
                "line-color": [
                  "match",
                  ["get", "class"],
                  "subway",
                  PRIMARY_BLUE_HEX,
                  "tram",
                  "#0F9D58",
                  "rail",
                  "#5F6368",
                  "bus",
                  "#F29900",
                  "ferry",
                  "#00ACC1",
                  "#34A853",
                ],
                "line-opacity": 0.95,
                "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 10, 1.8, 14, 3],
              },
              layout: {
                "line-cap": "round",
                "line-join": "round",
              },
            },
            beforeLayerId,
          );
        }
      }

      if (showTransit) {
        moveLayerBeforeFirstSymbol(map, TRANSIT_LAYER_ID);
      }

      setLayerVisibility(map, TRANSIT_LAYER_ID, showTransit);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, mapRef, styleVersion, showTransit]);

  return null;
}
