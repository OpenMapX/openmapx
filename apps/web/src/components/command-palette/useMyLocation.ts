"use client";

import { useMapStore } from "@openmapx/core";
import { useCallback } from "react";
import { useMapOptional } from "@/lib/MapContext";

/**
 * Returns a function that asks the browser for the user's current location and
 * flies the map to it. Silently no-ops if geolocation is unavailable, denied,
 * or if the caller is rendered outside `<MapProvider>` (e.g. non-map routes).
 */
export function useMyLocation(): () => void {
  const setUserLocation = useMapStore((s) => s.setUserLocation);
  const map = useMapOptional();
  return useCallback(() => {
    // True no-op outside <MapProvider>: no geolocation prompt and no
    // user-location store update either, since neither is meaningful
    // without a map to fly to.
    if (!map) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lngLat: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setUserLocation(lngLat);
        map.flyTo(lngLat, 14);
      },
      () => {},
    );
  }, [setUserLocation, map]);
}
