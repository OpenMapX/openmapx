"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { getFirstSymbolLayerId, setLayerVisibility } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useMap } from "@/lib/MapContext";
import { useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = 14;
const AUTO_PITCH = 45;
const MAX_PITCH_3D = 85;

interface CameraState {
  pitch: number;
  maxPitch: number;
}

const EXTRUSION_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "render_height"],
  0,
  "#d4d0cc",
  20,
  "#c8c4c0",
  60,
  "#b8b4b2",
  150,
  "#a8a6a8",
  300,
  "#9898a0",
];

const EXTRUSION_HEIGHT: maplibregl.ExpressionSpecification = ["get", "render_height"];

const EXTRUSION_BASE: maplibregl.ExpressionSpecification = ["get", "render_min_height"];

function findVectorSource(map: maplibregl.Map): string | null {
  const sources = map.getStyle().sources;
  if (!sources) return null;
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === "vector") return id;
  }
  return null;
}

function setOriginalBuildingLayersVisibility(map: maplibregl.Map, visible: boolean): void {
  const layers = map.getStyle().layers ?? [];
  for (const layer of layers) {
    if (layer.id !== LAYER_ID && "source-layer" in layer && layer["source-layer"] === "building") {
      map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
    }
  }
}

export function BuildingExtrusionLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useBuildingsStore((s) => s.layerVisible);
  useOverlayExclusion("3d-buildings", layerVisible);
  useLayerReanchor(LAYER_ID, layerVisible);

  const prevVisibleRef = useRef(false);
  const cameraBeforeEnableRef = useRef<CameraState | null>(null);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (layerVisible) {
        setOriginalBuildingLayersVisibility(map, false);
        map.setLight({
          anchor: "viewport",
          color: "#ffffff",
          intensity: 0.4,
          position: [1.5, 210, 30],
        });

        if (!map.getLayer(LAYER_ID)) {
          const source = findVectorSource(map);
          if (!source) return;

          map.addLayer(
            {
              id: LAYER_ID,
              type: "fill-extrusion",
              source,
              "source-layer": "building",
              minzoom: MIN_ZOOM,
              filter: ["!=", ["get", "hide_3d"], true],
              paint: {
                "fill-extrusion-color": EXTRUSION_COLOR,
                "fill-extrusion-height": EXTRUSION_HEIGHT,
                "fill-extrusion-base": EXTRUSION_BASE,
                "fill-extrusion-opacity": 1,
                "fill-extrusion-vertical-gradient": true,
              },
            },
            getFirstSymbolLayerId(map),
          );
        }

        setLayerVisibility(map, LAYER_ID, true);
      } else {
        setLayerVisibility(map, LAYER_ID, false);
        setOriginalBuildingLayersVisibility(map, true);
      }
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  // Auto-pitch on enable, restore the user's previous camera on disable.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (layerVisible && !prevVisibleRef.current) {
      const cameraBeforeEnable = {
        pitch: map.getPitch(),
        maxPitch: map.getMaxPitch(),
      };
      cameraBeforeEnableRef.current = cameraBeforeEnable;
      map.setMaxPitch(Math.max(cameraBeforeEnable.maxPitch, MAX_PITCH_3D));
      if (map.getPitch() < 10) {
        map.easeTo({ pitch: AUTO_PITCH, duration: 800 });
      }
    }

    if (!layerVisible && prevVisibleRef.current) {
      const cameraBeforeEnable = cameraBeforeEnableRef.current;
      if (cameraBeforeEnable) {
        if (Math.abs(map.getPitch() - cameraBeforeEnable.pitch) > 0.1) {
          map.easeTo({ pitch: cameraBeforeEnable.pitch, duration: 600 });
        }
        map.setMaxPitch(cameraBeforeEnable.maxPitch);
      }
      cameraBeforeEnableRef.current = null;
    }

    prevVisibleRef.current = layerVisible;
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  return null;
}
