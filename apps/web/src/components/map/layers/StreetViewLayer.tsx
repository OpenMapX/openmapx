"use client";

import { useStreetViewStore } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId } from "./layerStyleUtils";

const MLY_SOURCE_ID = "mly1_public";
const MLY_SEQUENCE_LAYER = "mapillary-sequence-layer";
const MLY_PHOTO_LAYER = "mapillary-photo-layer";
const MLY_PANO_LAYER = "mapillary-pano-layer";
const MLY_LAYERS = [MLY_SEQUENCE_LAYER, MLY_PHOTO_LAYER, MLY_PANO_LAYER] as const;
// Sequence lines are visual-only; only dots carry a usable image ID.
const MLY_INTERACTIVE_LAYERS = [MLY_PHOTO_LAYER, MLY_PANO_LAYER] as const;

export function StreetViewLayer() {
  const { mapRef, mapReady } = useMap();
  const showCoverage = useStreetViewStore((s) => s.showCoverage);
  const setActiveImageId = useStreetViewStore((s) => s.setActiveImageId);

  // Manage coverage layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const token = process.env.NEXT_PUBLIC_MAPILLARY_TOKEN ?? "";

    const syncLayers = () => {
      if (!map.isStyleLoaded()) return;

      if (!showCoverage) {
        for (const layerId of MLY_LAYERS) {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        }
        if (map.getSource(MLY_SOURCE_ID)) map.removeSource(MLY_SOURCE_ID);
        return;
      }

      if (!map.getSource(MLY_SOURCE_ID)) {
        map.addSource(MLY_SOURCE_ID, {
          type: "vector",
          tiles: [
            `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${token}`,
          ],
          minzoom: 6,
          maxzoom: 14,
          attribution: '© <a href="https://www.mapillary.com/" target="_blank">Mapillary</a>',
        });
      }

      const beforeLayerId = getFirstSymbolLayerId(map);

      if (!map.getLayer(MLY_SEQUENCE_LAYER)) {
        map.addLayer(
          {
            id: MLY_SEQUENCE_LAYER,
            type: "line",
            source: MLY_SOURCE_ID,
            "source-layer": "sequence",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#03a9f4",
              "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 14, 4],
              "line-opacity": 0.85,
            },
          },
          beforeLayerId,
        );
      }

      if (!map.getLayer(MLY_PHOTO_LAYER)) {
        map.addLayer(
          {
            id: MLY_PHOTO_LAYER,
            type: "circle",
            source: MLY_SOURCE_ID,
            "source-layer": "image",
            filter: ["==", ["get", "is_pano"], false],
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6],
              "circle-color": "#03a9f4",
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 1,
            },
          },
          beforeLayerId,
        );
      }

      if (!map.getLayer(MLY_PANO_LAYER)) {
        map.addLayer(
          {
            id: MLY_PANO_LAYER,
            type: "circle",
            source: MLY_SOURCE_ID,
            "source-layer": "image",
            filter: ["==", ["get", "is_pano"], true],
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 10],
              "circle-color": "rgba(3,169,244,0.15)",
              "circle-stroke-color": "#03a9f4",
              "circle-stroke-width": 2,
            },
          },
          beforeLayerId,
        );
      }
    };

    if (!showCoverage) {
      syncLayers();
      return;
    }

    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, mapRef, showCoverage]);

  // Click + cursor handlers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !showCoverage) return;

    const handleClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (id != null) setActiveImageId(String(id));
    };

    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    for (const layerId of MLY_INTERACTIVE_LAYERS) {
      map.on("click", layerId, handleClick);
      map.on("mouseenter", layerId, handleMouseEnter);
      map.on("mouseleave", layerId, handleMouseLeave);
    }

    return () => {
      for (const layerId of MLY_INTERACTIVE_LAYERS) {
        map.off("click", layerId, handleClick);
        map.off("mouseenter", layerId, handleMouseEnter);
        map.off("mouseleave", layerId, handleMouseLeave);
      }
    };
  }, [mapReady, mapRef, showCoverage, setActiveImageId]);

  return null;
}
