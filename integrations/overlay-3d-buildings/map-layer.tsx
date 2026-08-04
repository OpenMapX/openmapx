"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot } from "@/components/map/layers/layerStack";
import { setLayerVisibility } from "@/components/map/layers/layerStyleUtils";
import { useMap } from "@/lib/MapContext";
import {
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingSourceReference,
} from "./building-style";
import { useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = 14;
const AUTO_PITCH = 45;
const MAX_PITCH_3D = 85;

interface CameraState {
  pitch: number;
  maxPitch: number;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function moveToPitch(map: maplibregl.Map, pitch: number, duration: number): void {
  if (prefersReducedMotion()) {
    map.jumpTo({ pitch });
    return;
  }
  map.easeTo({ pitch, duration });
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
        const buildingSource = findBuildingSourceReference(map);
        if (!buildingSource) return;

        setOriginalBuildingLayersVisibility(map, false);
        map.setLight({
          anchor: "viewport",
          color: "#ffffff",
          intensity: 0.4,
          position: [1.5, 210, 30],
        });

        if (!map.getLayer(LAYER_ID)) {
          addLayerInSlot(
            map,
            {
              id: LAYER_ID,
              type: "fill-extrusion",
              source: buildingSource.source,
              "source-layer": buildingSource.sourceLayer,
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
            "area-overlays",
            5,
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
        moveToPitch(map, AUTO_PITCH, 800);
      }
    }

    if (!layerVisible && prevVisibleRef.current) {
      const cameraBeforeEnable = cameraBeforeEnableRef.current;
      if (cameraBeforeEnable) {
        if (Math.abs(map.getPitch() - cameraBeforeEnable.pitch) > 0.1) {
          moveToPitch(map, cameraBeforeEnable.pitch, 600);
        }
        map.setMaxPitch(cameraBeforeEnable.maxPitch);
      }
      cameraBeforeEnableRef.current = null;
    }

    prevVisibleRef.current = layerVisible;
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  return null;
}
