"use client";

import { useColorScheme, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useLayerStore } from "@openmapx/core";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useMapCenterWeather } from "@/components/weather/useMapCenterWeather";
import { useMap } from "@/integration-api/map/MapContext";
import {
  computeSceneLight,
  overcastFromWeather,
  sceneLightEqual,
  toMapLibreLight,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useGlobeLightingActive } from "./globe/globeLighting";

/** The sun moves about a quarter of a degree a minute. */
const SUN_REFRESH_MS = 60_000;
/** A smaller pan moves the sun by less than a minute's worth. */
const CENTER_STEP_DEG = 0.25;

/**
 * The one producer of the scene light: computes it from the sun at the map
 * centre, the theme, the base map, the "Day and night" preference and the
 * weather, publishes it for the 3D layers and the globe sky, and owns
 * MapLibre's light.
 */
export function SceneLighting() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const satellite = useLayerStore((s) => s.activeLayer) === "satellite";
  const globeView = useLayerStore((s) => s.globeView);
  const realtime = useGlobeLightingActive();
  const threeDActive = useOverlayLayerVisible("3d-buildings");
  const night = dark && !satellite;
  const live = !night && realtime;

  const center = useMapCenter();
  const now = useSunClock(live && (globeView || threeDActive));
  const { data: weather } = useMapCenterWeather({
    enabled: !isMobile && live && threeDActive,
  });
  const overcast = overcastFromWeather(weather?.current);

  // The real-time light waits for the map centre; night and the fixed light need none.
  const light = useMemo(
    () =>
      center || !live
        ? computeSceneLight({
            date: new Date(now),
            center: center ?? { lat: 0, lng: 0 },
            dark,
            satellite,
            realtime,
            overcast,
          })
        : null,
    [now, center, live, dark, satellite, realtime, overcast],
  );

  // Before paint, so a dark start never shows a frame of the initial light sky.
  useLayoutEffect(() => {
    if (!light) return;
    const store = useSceneLightStore.getState();
    if (!sceneLightEqual(store.light, light)) store.publish(light);
  }, [light]);

  // MapLibre refuses a light while a style loads, and a new style drops it,
  // so the light is only ever applied once the style is parsed.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !light) return;
    return subscribeStyleLoaded(map, () => map.setLight(toMapLibreLight(light)));
  }, [light, mapReady, styleVersion, mapRef]);

  return null;
}

/** The map centre, updated only when a pan moves it far enough to matter for the sun. */
function useMapCenter(): { lat: number; lng: number } | null {
  const { mapRef, mapReady } = useMap();
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const update = () => {
      const { lat, lng } = map.getCenter();
      setCenter((current) =>
        current &&
        Math.abs(current.lat - lat) < CENTER_STEP_DEG &&
        Math.abs(current.lng - lng) < CENTER_STEP_DEG
          ? current
          : { lat, lng },
      );
    };
    update();
    map.on("moveend", update);
    return () => {
      map.off("moveend", update);
    };
  }, [mapReady, mapRef]);
  return center;
}

/** The current time, moved on once a minute while it matters and the page is visible. */
function useSunClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, SUN_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running]);
  return now;
}
