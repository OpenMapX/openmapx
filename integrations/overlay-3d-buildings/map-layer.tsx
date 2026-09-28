"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import {
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingRoofColor,
  findBuildingSourceReference,
} from "./building-style";
import { useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = 16.5;
const AUTO_PITCH = 45;

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

export function BuildingExtrusionLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useBuildingsStore((s) => s.layerVisible);
  useOverlayExclusion("3d-buildings", layerVisible);

  const prevVisibleRef = useRef(false);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      const buildingSource = findBuildingSourceReference(map);
      if (!buildingSource) return;

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
              "fill-extrusion-color": findBuildingRoofColor(map, buildingSource) ?? EXTRUSION_COLOR,
              "fill-extrusion-height": EXTRUSION_HEIGHT,
              "fill-extrusion-base": EXTRUSION_BASE,
              "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 16.5, 0, 17, 1],
              "fill-extrusion-vertical-gradient": true,
            },
          },
          "area-overlays",
          5,
        );
        map.setLight({
          anchor: "viewport",
          color: "#ffffff",
          intensity: 0.4,
          position: [1.5, 210, 30],
        });
      }
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, styleVersion, mapRef]);

  // The selector is a camera shortcut. Building geometry is part of the
  // close-up basemap, so gestures and deep links reveal it without this toggle.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (layerVisible && !prevVisibleRef.current) {
      if (map.getPitch() <= 0.5) {
        moveToPitch(map, AUTO_PITCH, 800);
      }
    }

    if (!layerVisible && prevVisibleRef.current) {
      if (map.getPitch() > 0.5) {
        moveToPitch(map, 0, 600);
      }
    }

    prevVisibleRef.current = layerVisible;
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const syncViewState = () => {
      const tilted = map.getPitch() > 0.5;
      const state = useBuildingsStore.getState();
      if (state.layerVisible === tilted) return;
      if (tilted) state.openPanel();
      else state.closePanel();
    };
    // An initial pitched camera may come from a saved view or deep link. Do
    // not clear an explicit 3D request before its camera animation begins.
    if (map.getPitch() > 0.5) syncViewState();
    map.on("moveend", syncViewState);
    return () => {
      map.off("moveend", syncViewState);
    };
  }, [mapReady, mapRef]);

  return null;
}
