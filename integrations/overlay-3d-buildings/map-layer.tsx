"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { getFirstSymbolLayerId, setLayerVisibility } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import {
  type BasemapLod2Layer,
  createBasemapLod2Layer,
  supportsBasemapLod2View,
} from "./basemap-lod2";
import {
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingSourceReference,
} from "./building-style";
import { useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const DETAILED_LAYER_ID = "openmapx-3d-buildings-lod2";
const REANCHOR_LAYER_IDS = [LAYER_ID, DETAILED_LAYER_ID] as const;
const MIN_ZOOM = 14;
const AUTO_PITCH = 45;
const MAX_PITCH_3D = 85;
const DETAIL_READY_POLL_MS = 100;
const DETAIL_READY_MAX_POLLS = 150;

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

function removeDetailedLayer(map: maplibregl.Map): void {
  try {
    if (map.getLayer(DETAILED_LAYER_ID)) map.removeLayer(DETAILED_LAYER_ID);
  } catch {
    // The style may already be tearing down.
  }
}

export function BuildingExtrusionLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useBuildingsStore((s) => s.layerVisible);
  const [usingDetailedBuildings, setUsingDetailedBuildings] = useState(false);
  useIntegrationAttribution("overlay-3d-buildings", usingDetailedBuildings);
  useOverlayExclusion("3d-buildings", layerVisible);
  useLayerReanchor(REANCHOR_LAYER_IDS, layerVisible);

  const prevVisibleRef = useRef(false);
  const cameraBeforeEnableRef = useRef<CameraState | null>(null);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let cancelled = false;
    let detailedLayer: BasemapLod2Layer | null = null;
    let detailedLoadPromise: Promise<void> | null = null;
    let readinessTimer: number | undefined;
    let readinessGeneration = 0;
    let detailedVisible = false;

    const showFallback = () => {
      detailedVisible = false;
      setLayerVisibility(map, LAYER_ID, true);
      setLayerVisibility(map, DETAILED_LAYER_ID, false);
      if (!cancelled) setUsingDetailedBuildings(false);
    };

    const stopDetailedLayer = () => {
      readinessGeneration += 1;
      if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
      readinessTimer = undefined;
      removeDetailedLayer(map);
      detailedLayer = null;
      showFallback();
    };

    const revealWhenReady = (layer: BasemapLod2Layer, generation: number, poll = 0) => {
      if (
        cancelled ||
        generation !== readinessGeneration ||
        !layerVisible ||
        !supportsBasemapLod2View(map) ||
        !map.getLayer(DETAILED_LAYER_ID)
      ) {
        return;
      }

      if (layer.loadStatus === 1) {
        detailedVisible = true;
        setLayerVisibility(map, DETAILED_LAYER_ID, true);
        setLayerVisibility(map, LAYER_ID, false);
        setUsingDetailedBuildings(true);
        map.triggerRepaint();
        return;
      }

      if (poll >= DETAIL_READY_MAX_POLLS) {
        showFallback();
        return;
      }

      readinessTimer = window.setTimeout(() => {
        readinessTimer = undefined;
        revealWhenReady(layer, generation, poll + 1);
      }, DETAIL_READY_POLL_MS);
    };

    const startDetailedLayer = () => {
      if (map.getLayer(DETAILED_LAYER_ID) && detailedLayer) {
        if (detailedVisible) return;
        if (readinessTimer !== undefined) return;
        const generation = ++readinessGeneration;
        revealWhenReady(detailedLayer, generation);
        return;
      }
      if (detailedLoadPromise) return;

      // Set the guard before changing layout visibility: MapLibre may emit a
      // synchronous styledata event from setLayoutProperty.
      detailedLoadPromise = Promise.resolve();
      showFallback();
      const generation = ++readinessGeneration;
      detailedLoadPromise = createBasemapLod2Layer(DETAILED_LAYER_ID)
        .then((layer) => {
          if (cancelled || generation !== readinessGeneration) return;
          if (!layerVisible || !supportsBasemapLod2View(map) || !map.isStyleLoaded()) return;

          if (!map.getLayer(DETAILED_LAYER_ID)) {
            map.addLayer(layer, getFirstSymbolLayerId(map));
            setLayerVisibility(map, DETAILED_LAYER_ID, false);
          }
          detailedLayer = layer;
          revealWhenReady(layer, generation);
        })
        .catch((error: unknown) => {
          console.warn("Detailed basemap.de buildings unavailable; using vector fallback", error);
          showFallback();
        })
        .finally(() => {
          detailedLoadPromise = null;
        });
    };

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
          map.addLayer(
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
            getFirstSymbolLayerId(map),
          );
        }

        if (supportsBasemapLod2View(map)) {
          startDetailedLayer();
        } else {
          stopDetailedLayer();
        }
      } else {
        stopDetailedLayer();
        setLayerVisibility(map, LAYER_ID, false);
        setOriginalBuildingLayersVisibility(map, true);
      }
    };

    syncLayer();
    map.on("styledata", syncLayer);
    map.on("moveend", syncLayer);
    return () => {
      cancelled = true;
      readinessGeneration += 1;
      if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
      map.off("styledata", syncLayer);
      map.off("moveend", syncLayer);
      removeDetailedLayer(map);
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
