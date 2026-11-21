"use client";

import { useColorScheme } from "@mui/material/styles";
import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { type GlobeSkyContent, GlobeSkyLayer, type GlobeSkyOptions } from "./globe/GlobeSkyLayer";
import { MILKY_WAY_ATTRIBUTION, NIGHT_LIGHTS_ATTRIBUTION } from "./globe/globeCredits";

type SkySpecification = Parameters<maplibregl.Map["setSky"]>[0];

// MapLibre's own haze is off while the globe draws its own glow, and takes
// over in tilted views as that glow fades out between zoom 5 and 7.
const VECTOR_ATMOSPHERE: SkySpecification["atmosphere-blend"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  0,
  0,
  5,
  0,
  7,
  0.37,
  8,
  0.25,
  11,
  0,
];
const SATELLITE_ATMOSPHERE: SkySpecification["atmosphere-blend"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  0,
  0,
  5,
  0,
  7,
  0.32,
  8,
  0,
];

// Without the globe's own sky (a GPU that cannot run it), MapLibre's haze
// stays on at every globe zoom, as it did before the globe had a sky.
const FALLBACK_VECTOR_ATMOSPHERE: SkySpecification["atmosphere-blend"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  0,
  0.6,
  5,
  0.6,
  8,
  0.25,
  11,
  0,
];
const FALLBACK_SATELLITE_ATMOSPHERE: SkySpecification["atmosphere-blend"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  0,
  0.95,
  5,
  0.95,
  8,
  0,
];

const LIGHT_SKY: SkySpecification = {
  "sky-color": "#88C6FC",
  "horizon-color": "#d6e8f7",
  "fog-color": "#ffffff",
  "sky-horizon-blend": 0.5,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.1,
  "atmosphere-blend": VECTOR_ATMOSPHERE,
};

const DARK_SKY: SkySpecification = {
  "sky-color": "#0a0a1a",
  "horizon-color": "#101828",
  "fog-color": "#0a0a0a",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.1,
  "atmosphere-blend": VECTOR_ATMOSPHERE,
};

const SATELLITE_SKY: SkySpecification = {
  "sky-color": "#0a0a2e",
  "horizon-color": "#1a3a5e",
  "fog-color": "#000000",
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.3,
  "fog-ground-blend": 0,
  "atmosphere-blend": SATELLITE_ATMOSPHERE,
};

const LIGHT_BG = "#d6e8f7";
const DARK_BG = "#101828";
const SATELLITE_BG = "#020306";

/** City lights and the rest of the lighting are gone from this zoom. */
const LIGHTING_MAX_ZOOM = 7;
/** Below this zoom the sky is mostly space, whatever the theme. */
const SPACE_MAX_ZOOM = 6.5;
/** The terminator moves a quarter of a degree a minute. */
const SUN_REFRESH_MS = 60_000;

const ZOOM_OUT_THRESHOLD = 11;
const ZOOM_OUT_TARGET = 3;
const ZOOM_OUT_DURATION = 1500;

function getSky(activeLayer: string, isDark: boolean, ownSky: boolean): SkySpecification {
  const satellite = activeLayer === "satellite";
  const sky = satellite ? SATELLITE_SKY : isDark ? DARK_SKY : LIGHT_SKY;
  if (ownSky) return sky;
  return {
    ...sky,
    "atmosphere-blend": satellite ? FALLBACK_SATELLITE_ATMOSPHERE : FALLBACK_VECTOR_ATMOSPHERE,
  };
}

const NOTHING_DRAWN: GlobeSkyContent = { milkyWay: false, nightLights: false };

function backgroundColor(activeLayer: string, isDark: boolean): string {
  if (activeLayer === "satellite") return SATELLITE_BG;
  return isDark ? DARK_BG : LIGHT_BG;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function GlobeProjection() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const globeView = useLayerStore((s) => s.globeView);
  const globeCameraBehavior = useLayerStore((s) => s.globeCameraBehavior);
  const globeLighting = useLayerStore((s) => s.globeLighting);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const { mode, systemMode } = useColorScheme();
  const isDark = (mode === "system" ? systemMode : mode) === "dark";
  // Initialise to false so the zoom-out animation also triggers on page
  // reload when globeView was persisted — otherwise the map would start at
  // a high zoom (e.g. geolocation zoom 14) where the globe preset already
  // blends to flat mercator and the user wouldn't see the globe.
  const prevGlobeRef = useRef(false);
  const satellite = activeLayer === "satellite";
  const background = backgroundColor(activeLayer, isDark);
  const skyZoom = useSkyZoom(globeView);
  const [skyUnavailable, setSkyUnavailable] = useState(false);
  const [drawn, setDrawn] = useState<GlobeSkyContent>(NOTHING_DRAWN);
  const ownSky = !skyUnavailable;
  // Shows only in frames without the sky layer, such as a style reload: keep
  // it dark where the sky would be space, so the globe does not flash light.
  const containerBackground = skyZoom.space && ownSky ? SATELLITE_BG : background;

  const options = useMemo<GlobeSkyOptions>(
    () => ({
      lighting: globeLighting,
      base: satellite ? "satellite" : "map",
      dark: isDark,
      themeSky: rgb(background),
    }),
    [globeLighting, satellite, isDark, background],
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const skyLayerRef = useRef<GlobeSkyLayer | null>(null);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const container = map.getContainer();
    const previousBackground = container.style.backgroundColor;
    if (globeView) container.style.backgroundColor = containerBackground;

    const apply = () => {
      const projection = globeView ? "globe" : "mercator";
      if ((map.getProjection()?.type ?? "mercator") !== projection) {
        map.setProjection({ type: projection });
      }
      const sky = globeView ? getSky(activeLayer, isDark, ownSky) : { "atmosphere-blend": 0 };
      const currentSky = map.getSky();
      if (
        Object.entries(sky).some(
          ([key, value]) =>
            JSON.stringify(currentSky?.[key as keyof SkySpecification]) !== JSON.stringify(value),
        )
      ) {
        map.setSky(sky);
      }
    };

    const unsubscribe = subscribeStyleLoaded(map, apply);

    return () => {
      unsubscribe();
      container.style.backgroundColor = previousBackground;
    };
  }, [globeView, activeLayer, isDark, ownSky, containerBackground, mapReady, styleVersion, mapRef]);

  // One sky layer while the globe is on: theme, base map, lighting and style
  // reloads update or re-add it rather than reloading its textures.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !globeView) return;

    const sky = new GlobeSkyLayer(optionsRef.current, {
      onContent: setDrawn,
      onUnavailable: () => setSkyUnavailable(true),
    });
    skyLayerRef.current = sky;
    // Style reloads (including WebGL context restoration) drop custom layers.
    // Re-add with fresh GPU resources, below every overlay and label.
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (!map.getLayer(sky.id)) addLayerInSlot(map, sky, "base-raster", 900);
    });

    return () => {
      unsubscribe();
      if (map.getLayer(sky.id)) map.removeLayer(sky.id);
      // A replacement style may already have dropped the layer without its
      // onRemove callback. Disposal is idempotent and also covers that path.
      sky.dispose();
      unregisterLayerSlot(sky.id);
      if (skyLayerRef.current === sky) skyLayerRef.current = null;
    };
  }, [globeView, mapReady, mapRef]);

  useEffect(() => {
    skyLayerRef.current?.setOptions(options);
  }, [options]);

  // Move the terminator on without an animation loop: one repaint a minute
  // while the lighting is visible, and one when the page becomes visible again.
  const lightingVisible = globeLighting && skyZoom.lighting;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !lightingVisible) return;
    const repaint = () => {
      if (document.visibilityState !== "hidden") map.triggerRepaint();
    };
    const timer = setInterval(repaint, SUN_REFRESH_MS);
    document.addEventListener("visibilitychange", repaint);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", repaint);
    };
  }, [lightingVisible, mapReady, mapRef]);

  // Credit what the layer actually drew, not what it was asked to draw.
  const credits = useMemo<Attribution[]>(() => {
    if (!globeView) return [];
    return [
      ...(drawn.milkyWay ? [MILKY_WAY_ATTRIBUTION] : []),
      ...(drawn.nightLights ? [NIGHT_LIGHTS_ATTRIBUTION] : []),
    ];
  }, [globeView, drawn]);
  useMapAttributions("globe-sky", credits);

  // Zoom out to showcase the globe when toggling on from a zoomed-in view
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const justEnabled = globeView && !prevGlobeRef.current;
    prevGlobeRef.current = globeView;

    if (!justEnabled || globeCameraBehavior === "preserve") return;
    if (map.getZoom() <= ZOOM_OUT_THRESHOLD) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      map.jumpTo({ zoom: ZOOM_OUT_TARGET }, { programmatic: true });
    } else {
      map.easeTo({ zoom: ZOOM_OUT_TARGET, duration: ZOOM_OUT_DURATION }, { programmatic: true });
    }
  }, [globeView, globeCameraBehavior, mapReady, styleVersion, mapRef]);

  return null;
}

interface SkyZoom {
  /** Day and night, city lights and the Sun draw. */
  lighting: boolean;
  /** The background is mostly space. */
  space: boolean;
}

const HIDDEN: SkyZoom = { lighting: false, space: false };

function skyZoomAt(zoom: number): SkyZoom {
  return {
    lighting: zoom < LIGHTING_MAX_ZOOM,
    space: zoom < SPACE_MAX_ZOOM,
  };
}

/** Which parts of the globe's sky the camera's zoom shows; changes only at the thresholds. */
function useSkyZoom(globeView: boolean): SkyZoom {
  const { mapRef, mapReady } = useMap();
  const [zoomState, setZoomState] = useState<SkyZoom>(HIDDEN);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !globeView) return;
    const update = () => {
      const next = skyZoomAt(map.getZoom());
      setZoomState((current) =>
        current.lighting === next.lighting && current.space === next.space ? current : next,
      );
    };
    update();
    map.on("zoom", update);
    return () => {
      map.off("zoom", update);
    };
  }, [globeView, mapReady, mapRef]);
  return globeView ? zoomState : HIDDEN;
}
