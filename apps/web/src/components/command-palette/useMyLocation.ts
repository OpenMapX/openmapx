"use client";

import { useMapStore } from "@openmapx/core";
import { useCallback } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";

/**
 * Returns a function that asks for the user's current location and flies the map
 * to it. Silently no-ops if location is unavailable, denied, or if the caller is
 * rendered outside `<MapProvider>` (e.g. non-map routes).
 *
 * Goes through the one-fix adapter rather than `navigator.geolocation` directly:
 * inside the installed shell native owns the only location subscription, and a
 * browser fix taken beside it would be a second sensor answering the same
 * question.
 */
export function useMyLocation(): () => void {
  const setUserLocation = useMapStore((s) => s.setUserLocation);
  const mapCtx = useMapOptional();
  const requestFix = useForegroundLocation();
  return useCallback(() => {
    // True no-op outside <MapProvider>: no location prompt and no
    // user-location store update either, since neither is meaningful
    // without a map to fly to.
    if (!mapCtx) return;
    void requestFix().then((result) => {
      if (result.status !== "ok") return;
      const lngLat: [number, number] = [result.fix.lng, result.fix.lat];
      setUserLocation(lngLat);
      mapCtx.flyTo(lngLat, 14);
    });
  }, [setUserLocation, mapCtx, requestFix]);
}
