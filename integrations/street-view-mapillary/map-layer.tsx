"use client";

import {
  buildIntegrationAttribution,
  useIntegrationRegistry,
  useOverlayExclusion,
} from "@openmapx/core";
import type { MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import { useEffect } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useStreetViewStore } from "./store";

const MLY_SOURCE_ID = "mly1_public";
const MLY_SEQUENCE_LAYER = "mapillary-sequence-layer";
const MLY_PHOTO_LAYER = "mapillary-photo-layer";
const MLY_PANO_LAYER = "mapillary-pano-layer";
const MLY_LAYERS = [MLY_SEQUENCE_LAYER, MLY_PHOTO_LAYER, MLY_PANO_LAYER] as const;
// Sequence lines are visual-only; only dots carry a usable image ID.
const MLY_INTERACTIVE_LAYERS = [MLY_PHOTO_LAYER, MLY_PANO_LAYER] as const;

export function StreetViewLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const registry = useIntegrationRegistry();
  const meta = registry.get("street-view-mapillary");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const layerVisible = useStreetViewStore((s) => s.layerVisible);
  const setActiveImageId = useStreetViewStore((s) => s.setActiveImageId);
  useOverlayExclusion("street-view", layerVisible);
  useLayerReanchor(MLY_LAYERS, layerVisible);

  // Manage coverage layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const { apiUrl } = env;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          for (const layerId of MLY_LAYERS) {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
          }
          if (map.getSource(MLY_SOURCE_ID)) map.removeSource(MLY_SOURCE_ID);
        } catch {
          // Tiles may still be in-flight when the source is torn down
        }
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayers);
        return;
      }

      if (!map.getSource(MLY_SOURCE_ID)) {
        map.addSource(MLY_SOURCE_ID, {
          type: "vector",
          tiles: [`${apiUrl}/api/mapillary/tiles/{z}/{x}/{y}`],
          minzoom: 6,
          maxzoom: 14,
          attribution: attributionHtml,
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

    if (!layerVisible) {
      syncLayers();
      return;
    }

    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, env]);

  // Click + cursor handlers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const handleClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (id != null) setActiveImageId(String(id));
    };

    const handleMouseMove = (e: MapMouseEvent) => {
      const activeLayers = MLY_INTERACTIVE_LAYERS.filter((id) => !!map.getLayer(id));
      if (activeLayers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [...activeLayers] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    for (const layerId of MLY_INTERACTIVE_LAYERS) {
      map.on("click", layerId, handleClick);
    }
    map.on("mousemove", handleMouseMove);

    return () => {
      for (const layerId of MLY_INTERACTIVE_LAYERS) {
        map.off("click", layerId, handleClick);
      }
      map.off("mousemove", handleMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, setActiveImageId]);

  return null;
}
