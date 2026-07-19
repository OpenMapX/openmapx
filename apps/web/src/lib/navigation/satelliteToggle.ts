"use client";

import { type MapLayer, useLayerStore } from "@openmapx/core";
import { useEffect, useRef } from "react";

/** The base layer to switch to when the satellite toggle flips. Pure. */
export function nextSatelliteLayer(on: boolean, lastBase: MapLayer): MapLayer {
  return on ? lastBase : "satellite";
}

/**
 * Satellite as an on/off toggle over the base-layer store. Turning it off
 * restores the last non-satellite base layer the user was on (so satellite is
 * an overlay-like switch rather than losing their terrain/cycling choice).
 */
export function useSatelliteToggle(): { on: boolean; toggle: () => void } {
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const lastBaseRef = useRef<MapLayer>("default");
  useEffect(() => {
    if (activeLayer !== "satellite") lastBaseRef.current = activeLayer;
  }, [activeLayer]);
  const on = activeLayer === "satellite";
  return { on, toggle: () => setActiveLayer(nextSatelliteLayer(on, lastBaseRef.current)) };
}
