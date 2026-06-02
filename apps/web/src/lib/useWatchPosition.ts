"use client";

import type { FixInput } from "@openmapx/core";
import { useEffect, useRef } from "react";
import { hasCapability } from "./platformCapabilities";

/**
 * Subscribe to high-accuracy geolocation while `active`. Calls `onFix` per
 * update. Clears the watch on deactivate/unmount. No-op without geolocation.
 */
export function useWatchPosition(active: boolean, onFix: (fix: FixInput) => void): void {
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  useEffect(() => {
    if (!active || !hasCapability("geolocation")) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        onFixRef.current({
          coords: [pos.coords.longitude, pos.coords.latitude],
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timestampMs: pos.timestamp,
        });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 },
    );
    return () => navigator.geolocation?.clearWatch(id);
  }, [active]);
}
