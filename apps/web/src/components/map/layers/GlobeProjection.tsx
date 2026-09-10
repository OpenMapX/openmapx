"use client";

import { useColorScheme } from "@mui/material/styles";
import { useLayerStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { GlobeSpaceLayer } from "./GlobeSpaceLayer";

type SkySpecification = Parameters<maplibregl.Map["setSky"]>[0];

const LIGHT_SKY: SkySpecification = {
  "sky-color": "#88C6FC",
  "horizon-color": "#d6e8f7",
  "fog-color": "#ffffff",
  "sky-horizon-blend": 0.5,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.1,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 0.6, 8, 0.25, 11, 0],
};

const DARK_SKY: SkySpecification = {
  "sky-color": "#0a0a1a",
  "horizon-color": "#101828",
  "fog-color": "#0a0a0a",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.1,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 0.6, 8, 0.25, 11, 0],
};

const SATELLITE_SKY: SkySpecification = {
  "sky-color": "#0a0a2e",
  "horizon-color": "#1a3a5e",
  "fog-color": "#000000",
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.3,
  "fog-ground-blend": 0,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.95, 5, 0.95, 8, 0],
};

const LIGHT_BG = "#d6e8f7";
const DARK_BG = "#101828";

const ZOOM_OUT_THRESHOLD = 11;
const ZOOM_OUT_TARGET = 3;
const ZOOM_OUT_DURATION = 1500;

function getSky(activeLayer: string, isDark: boolean): SkySpecification {
  if (activeLayer === "satellite") return SATELLITE_SKY;
  return isDark ? DARK_SKY : LIGHT_SKY;
}

export function GlobeProjection() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const globeView = useLayerStore((s) => s.globeView);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const { mode, systemMode } = useColorScheme();
  const isDark = (mode === "system" ? systemMode : mode) === "dark";
  // Initialise to false so the zoom-out animation also triggers on page
  // reload when globeView was persisted — otherwise the map would start at
  // a high zoom (e.g. geolocation zoom 14) where the globe preset already
  // blends to flat mercator and the user wouldn't see the globe.
  const prevGlobeRef = useRef(false);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const container = map.getContainer();
    const isSatelliteGlobe = globeView && activeLayer === "satellite";

    const previousBackground = container.style.backgroundColor;
    const space = new GlobeSpaceLayer();
    container.style.backgroundColor = globeView
      ? isSatelliteGlobe
        ? "#020306"
        : isDark
          ? DARK_BG
          : LIGHT_BG
      : previousBackground;

    const apply = () => {
      if (globeView) {
        map.setProjection({ type: "globe" });
        map.setSky(getSky(activeLayer, isDark));
      } else {
        map.setProjection({ type: "mercator" });
        map.setSky({ "atmosphere-blend": 0 });
      }
      // Style reloads (including WebGL context restoration) drop custom layers.
      // Re-add with fresh GPU resources, in the same stack as the base imagery.
      if (isSatelliteGlobe && !map.getLayer(space.id)) {
        addLayerInSlot(map, space, "base-raster", -100);
      }
    };

    // Apply immediately only when the style is fully loaded. Otherwise wait
    // for `style.load` — this avoids racing with setStyle() during theme
    // swaps where setStyle() would reset the projection right after we set it.
    if (map.isStyleLoaded()) {
      apply();
    }

    const onStyleLoad = () => apply();
    map.on("style.load", onStyleLoad);

    return () => {
      map.off("style.load", onStyleLoad);
      if (map.getLayer(space.id)) map.removeLayer(space.id);
      // A replacement style may already have dropped the layer without its
      // onRemove callback. Disposal is idempotent and also covers that path.
      space.dispose();
      unregisterLayerSlot(space.id);
      container.style.backgroundColor = previousBackground;
    };
  }, [globeView, activeLayer, isDark, mapReady, styleVersion, mapRef]);

  // Zoom out to showcase the globe when toggling on from a zoomed-in view
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const justEnabled = globeView && !prevGlobeRef.current;
    prevGlobeRef.current = globeView;

    if (!justEnabled) return;
    if (map.getZoom() <= ZOOM_OUT_THRESHOLD) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      map.jumpTo({ zoom: ZOOM_OUT_TARGET });
    } else {
      map.easeTo({ zoom: ZOOM_OUT_TARGET, duration: ZOOM_OUT_DURATION });
    }
  }, [globeView, mapReady, styleVersion, mapRef]);

  return null;
}
