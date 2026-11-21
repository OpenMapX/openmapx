"use client";

import { useCurrentWeather, useDebouncedCallback } from "@openmapx/core";
import { useCallback, useEffect, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";

/** Current weather is only asked for from this zoom, where one reading fits the view. */
const MIN_WEATHER_ZOOM = 8;

/**
 * The current weather at the map centre, rounded to 0.1° and refreshed 2 s
 * after the map stops moving. Every caller rounds the same way, so callers
 * at the same centre share one query and one request.
 */
export function useMapCenterWeather({ enabled }: { enabled: boolean }) {
  const { mapRef, mapReady } = useMap();
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [zoom, setZoom] = useState(0);

  const updateCenter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    setCenter({ lat: Math.round(c.lat * 10) / 10, lng: Math.round(c.lng * 10) / 10 });
    setZoom(map.getZoom());
  }, [mapRef]);

  const debouncedUpdate = useDebouncedCallback(updateCenter, 2000);

  useEffect(() => {
    if (!enabled) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    updateCenter();
    map.on("moveend", debouncedUpdate);
    return () => {
      map.off("moveend", debouncedUpdate);
    };
  }, [enabled, mapRef, mapReady, updateCenter, debouncedUpdate]);

  // Nulls disable the underlying query, so nothing is fetched.
  const active = enabled && center !== null && zoom >= MIN_WEATHER_ZOOM;
  const { data } = useCurrentWeather(active ? center.lat : null, active ? center.lng : null);
  return { data, zoom };
}
