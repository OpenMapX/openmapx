"use client";

import {
  type RadarMeta,
  useDebouncedCallback,
  useOverlayExclusion,
  type WeatherSubLayer,
} from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useWeatherStore } from "./store";

const RADAR_SOURCE_PREFIX = "weather-radar-";
const RADAR_LAYER_PREFIX = "weather-radar-layer-";
const OWM_SOURCE_ID = "weather-owm-source";
const OWM_LAYER_ID = "weather-owm-layer";
const WINDOW_SIZE = 5;

const OWM_LAYER_MAP: Record<WeatherSubLayer, string | null> = {
  radar: null,
  temperature: "temp_new",
  clouds: "clouds_new",
  wind: "wind_new",
  pressure: "pressure_new",
  precipitation: "precipitation_new",
};

export function WeatherLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useWeatherStore((s) => s.layerVisible);
  useIntegrationAttribution("overlay-weather", layerVisible);
  const activeSubLayer = useWeatherStore((s) => s.activeSubLayer);
  const radarHost = useWeatherStore((s) => s.radarHost);
  const radarPastFrames = useWeatherStore((s) => s.radarPastFrames);
  const radarNowcastFrames = useWeatherStore((s) => s.radarNowcastFrames);
  const radarFrameIndex = useWeatherStore((s) => s.radarFrameIndex);
  const radarPlaying = useWeatherStore((s) => s.radarPlaying);
  const setRadarMeta = useWeatherStore((s) => s.setRadarMeta);
  const setRadarFrameIndex = useWeatherStore((s) => s.setRadarFrameIndex);
  const setOwmAvailable = useWeatherStore((s) => s.setOwmAvailable);
  const setRadarLoading = useWeatherStore((s) => s.setRadarLoading);
  const setRadarUnavailable = useWeatherStore((s) => s.setRadarUnavailable);

  useOverlayExclusion("weather", layerVisible);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const radarRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const allFrames = useMemo(
    () => [...radarPastFrames, ...radarNowcastFrames],
    [radarPastFrames, radarNowcastFrames],
  );

  // Fetch radar metadata
  const fetchRadarMeta = useCallback(async () => {
    try {
      setRadarLoading(true);
      const res = await fetch(`${env.apiUrl}/api/integrations/overlay-weather/radar/meta`);
      if (!res.ok) {
        setRadarUnavailable(true);
        return;
      }
      const data = (await res.json()) as RadarMeta;
      setRadarMeta(data.host, data.past, data.nowcast);
      setRadarUnavailable(false);
    } catch {
      setRadarUnavailable(true);
    } finally {
      setRadarLoading(false);
    }
  }, [env.apiUrl, setRadarMeta, setRadarLoading, setRadarUnavailable]);

  // Fetch OWM availability
  useEffect(() => {
    if (!layerVisible) return;
    fetch(`${env.apiUrl}/api/integrations/overlay-weather/config`)
      .then((r) => r.json())
      .then((cfg: Record<string, boolean>) => setOwmAvailable(cfg.temperature === true))
      .catch(() => setOwmAvailable(false));
  }, [layerVisible, env.apiUrl, setOwmAvailable]);

  // Fetch radar metadata on open + refresh interval
  useEffect(() => {
    if (!layerVisible) return;
    fetchRadarMeta();
    radarRefreshRef.current = setInterval(fetchRadarMeta, 5 * 60 * 1000);
    return () => {
      if (radarRefreshRef.current) clearInterval(radarRefreshRef.current);
    };
  }, [layerVisible, fetchRadarMeta]);

  // Radar animation — use store.getState() to avoid re-creating interval on every frame
  const frameCountRef = useRef(allFrames.length);
  frameCountRef.current = allFrames.length;

  useEffect(() => {
    if (!radarPlaying || allFrames.length === 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      const current = useWeatherStore.getState().radarFrameIndex;
      setRadarFrameIndex((current + 1) % frameCountRef.current);
    }, 500);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [radarPlaying, allFrames.length, setRadarFrameIndex]);

  // Manage radar tile sources/layers with sliding window
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!layerVisible || activeSubLayer !== "radar" || allFrames.length === 0 || !radarHost) {
        // Clean up radar layers
        for (let i = 0; i < allFrames.length; i++) {
          const layerId = `${RADAR_LAYER_PREFIX}${i}`;
          const sourceId = `${RADAR_SOURCE_PREFIX}${i}`;
          try {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
          } catch {
            // ignore
          }
          unregisterLayerSlot(layerId);
        }
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      // During playback, bias the window forward to preload upcoming frames
      const preloadAhead = radarPlaying ? 2 : 0;
      const halfWindow = Math.floor(WINDOW_SIZE / 2);
      const windowStart = Math.max(0, radarFrameIndex - halfWindow);
      const windowEnd = Math.min(allFrames.length, windowStart + WINDOW_SIZE + preloadAhead);

      for (let i = windowStart; i < windowEnd; i++) {
        const sourceId = `${RADAR_SOURCE_PREFIX}${i}`;
        const layerId = `${RADAR_LAYER_PREFIX}${i}`;
        const frame = allFrames[i];

        if (!map.getSource(sourceId)) {
          const proxyTileUrl = `${env.apiUrl}/api/integrations/overlay-weather/radar/tile/{z}/{x}/{y}?path=${encodeURIComponent(frame.path)}`;
          map.addSource(sourceId, {
            type: "raster",
            tiles: [proxyTileUrl],
            tileSize: 256,
            maxzoom: 7,
          });
        }

        if (!map.getLayer(layerId)) {
          addLayerInSlot(
            map,
            {
              id: layerId,
              type: "raster",
              source: sourceId,
              paint: {
                "raster-opacity": i === radarFrameIndex ? 0.7 : 0,
              },
            },
            "raster-overlays",
            20,
          );
        } else {
          map.setPaintProperty(layerId, "raster-opacity", i === radarFrameIndex ? 0.7 : 0);
        }
      }

      // Remove sources outside window
      for (let i = 0; i < allFrames.length; i++) {
        if (i >= windowStart && i < windowEnd) continue;
        const layerId = `${RADAR_LAYER_PREFIX}${i}`;
        const sourceId = `${RADAR_SOURCE_PREFIX}${i}`;
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
          if (map.getSource(sourceId)) map.removeSource(sourceId);
        } catch {
          // ignore
        }
        unregisterLayerSlot(layerId);
      }
    };

    syncLayer();
  }, [
    mapReady,
    styleVersion,
    mapRef,
    layerVisible,
    activeSubLayer,
    radarHost,
    allFrames,
    radarFrameIndex,
    radarPlaying,
  ]);

  // Manage OWM tile layer
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const owmLayerName = OWM_LAYER_MAP[activeSubLayer];

    const syncLayer = () => {
      if (!layerVisible || !owmLayerName) {
        try {
          if (map.getLayer(OWM_LAYER_ID)) map.removeLayer(OWM_LAYER_ID);
          if (map.getSource(OWM_SOURCE_ID)) map.removeSource(OWM_SOURCE_ID);
        } catch {
          // ignore
        }
        unregisterLayerSlot(OWM_LAYER_ID);
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      const tileUrl = `${env.apiUrl}/api/integrations/overlay-weather/tiles/${owmLayerName}/{z}/{x}/{y}.png`;

      if (map.getSource(OWM_SOURCE_ID)) {
        // Update tile URL when sub-layer changes
        try {
          if (map.getLayer(OWM_LAYER_ID)) map.removeLayer(OWM_LAYER_ID);
          map.removeSource(OWM_SOURCE_ID);
        } catch {
          // ignore
        }
        unregisterLayerSlot(OWM_LAYER_ID);
      }

      map.addSource(OWM_SOURCE_ID, {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
      });

      addLayerInSlot(
        map,
        {
          id: OWM_LAYER_ID,
          type: "raster",
          source: OWM_SOURCE_ID,
          paint: { "raster-opacity": 0.5 },
        },
        "raster-overlays",
        21,
      );
    };

    syncLayer();
  }, [mapReady, styleVersion, mapRef, layerVisible, activeSubLayer, env.apiUrl]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (radarRefreshRef.current) clearInterval(radarRefreshRef.current);
    };
  }, []);

  // Fetch current weather + reverse geocode for viewport center (displayed in legend)
  const debouncedWeatherFetch = useDebouncedCallback(async () => {
    const map = mapRef.current;
    if (!map || !layerVisible) return;
    const center = map.getCenter();
    const lat = center.lat.toFixed(2);
    const lng = center.lng.toFixed(2);
    try {
      const [weatherRes, geoRes] = await Promise.all([
        fetch(`${env.apiUrl}/api/integrations/weather/current?lat=${lat}&lng=${lng}`),
        fetch(`${env.apiUrl}/api/integrations/geocoding/geocode/reverse?lat=${lat}&lng=${lng}`),
      ]);
      if (weatherRes.ok) {
        const data = await weatherRes.json();
        useWeatherStore.getState().setCurrentWeather(data.current);
      }
      if (geoRes.ok) {
        const geo = await geoRes.json();
        const name = geo?.city ?? geo?.address?.split(",")[0] ?? "";
        useWeatherStore.getState().setLocationName(name);
      }
    } catch {
      // silent
    }
  }, 1500);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    debouncedWeatherFetch();
    map.on("moveend", debouncedWeatherFetch);
    return () => {
      map.off("moveend", debouncedWeatherFetch);
    };
  }, [mapReady, mapRef, layerVisible, debouncedWeatherFetch]);

  return null;
}
