"use client";

import { runOverlayTransaction, useNavigationStore, useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import {
  buildingExtrusionColor,
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingRoofColor,
  findBuildingSourceReference,
} from "./building-style";
import manifest from "./manifest.json";
import { BUILDING_TILT_THRESHOLD as TILT_THRESHOLD, useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = manifest.frontend.overlay.minZoom;
const AUTO_PITCH = 45;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function moveToPitch(map: maplibregl.Map, pitch: number, duration: number): void {
  if (prefersReducedMotion()) {
    map.jumpTo({ pitch }, { programmatic: true });
    return;
  }
  map.easeTo({ pitch, duration }, { programmatic: true });
}

export function BuildingExtrusionLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useBuildingsStore((s) => s.layerVisible);
  useOverlayExclusion("3d-buildings", layerVisible);

  const prevVisibleRef = useRef(false);
  const wasTiltedRef = useRef(false);
  const currentMap = mapRef.current;

  useEffect(() => {
    const sync = () =>
      useBuildingsStore.getState().syncNavigation(useNavigationStore.getState().status !== "idle");
    sync();
    return useNavigationStore.subscribe(sync);
  }, []);

  useEffect(() => {
    void styleVersion;
    // Reconcile selection changes immediately; callbacks read the latest store.
    void layerVisible;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // An active selection needs a tilted camera to show geometry. The
    // selection itself remains authoritative when a user turns 3D off.
    const syncVisibility = () => {
      if (!map.getLayer(LAYER_ID)) return;
      const visibility =
        useBuildingsStore.getState().layerVisible && map.getPitch() > TILT_THRESHOLD
          ? "visible"
          : "none";
      if (map.getLayoutProperty(LAYER_ID, "visibility") !== visibility) {
        map.setLayoutProperty(LAYER_ID, "visibility", visibility);
      }
    };

    const syncLayer = () => {
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
            layout: {
              visibility:
                useBuildingsStore.getState().layerVisible && map.getPitch() > TILT_THRESHOLD
                  ? "visible"
                  : "none",
            },
            paint: {
              "fill-extrusion-color": buildingExtrusionColor(
                findBuildingRoofColor(map, buildingSource) ?? EXTRUSION_COLOR,
              ),
              "fill-extrusion-height": EXTRUSION_HEIGHT,
              "fill-extrusion-base": EXTRUSION_BASE,
              "fill-extrusion-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                MIN_ZOOM,
                0,
                MIN_ZOOM + 0.5,
                1,
              ],
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
      } else {
        syncVisibility();
      }
    };

    // Hiding an existing layer must not wait for unrelated tiles to finish.
    syncVisibility();
    const unsubscribe = subscribeStyleLoaded(map, syncLayer);
    map.on("pitch", syncVisibility);
    map.on("pitchend", syncVisibility);
    return () => {
      unsubscribe();
      map.off("pitch", syncVisibility);
      map.off("pitchend", syncVisibility);
    };
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  // Selecting 3D from the layer catalog also provides a useful camera angle.
  // Turning the layer off does not change a camera angle chosen by the user.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (layerVisible && !prevVisibleRef.current) {
      if (map.getPitch() <= TILT_THRESHOLD) {
        moveToPitch(map, AUTO_PITCH, 800);
      }
    }

    prevVisibleRef.current = layerVisible;
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  useEffect(() => {
    const map = currentMap;
    if (!map || !mapReady) return;
    const syncViewState = () => {
      const tilted = map.getPitch() > TILT_THRESHOLD;
      const state = useBuildingsStore.getState();
      if (useNavigationStore.getState().status !== "idle") {
        wasTiltedRef.current = tilted;
        return;
      }
      if (!tilted && state.cameraAutoEnableBlocked) state.setCameraAutoEnableBlocked(false);
      if (tilted === wasTiltedRef.current) return;
      wasTiltedRef.current = tilted;
      if (tilted && state.cameraAutoEnableBlocked) return;
      if (state.layerVisible === tilted) return;
      runOverlayTransaction(
        "3d-buildings",
        { panelOpen: tilted },
        { kind: "automation", owner: "3d-buildings-camera" },
      );
    };
    // An initial pitched camera may come from a saved view or deep link.
    // Only camera tilt transitions auto-select 3D; ordinary map movements
    // must not undo an explicit off choice while the camera stays tilted.
    if (map.getPitch() > TILT_THRESHOLD || wasTiltedRef.current) syncViewState();
    map.on("pitch", syncViewState);
    map.on("pitchend", syncViewState);
    return () => {
      map.off("pitch", syncViewState);
      map.off("pitchend", syncViewState);
    };
  }, [mapReady, currentMap]);

  return null;
}
