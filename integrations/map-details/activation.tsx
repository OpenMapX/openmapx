"use client";

import { useLayerStore, useNavigationStore } from "@openmapx/core";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";

/** The 3D view draws extrusions only while the camera is tilted past this. */
export const TILT_THRESHOLD = 0.5;
/** Paint reaches full opacity at this tilt, so a slight tilt does not flip road widths. */
const FULL_TILT = 10;
const FADE_THROTTLE_MS = 100;

export function pitchFadeOf(pitch: number): number {
  return Math.min(1, Math.max(0, (pitch - TILT_THRESHOLD) / (FULL_TILT - TILT_THRESHOLD)));
}

export interface MapDetailsActivation {
  active: boolean;
  /**
   * `navigation` during 3D navigation: street paint without pitches and only
   * the street signs (signals, stop, give way), no trees, lamps or benches.
   */
  mode: "full" | "navigation";
  zoom: number;
  pitchFade: number;
  satellite: boolean;
}

/**
 * Map details are part of the 3D view (spec §6.2): active while the 3D view is
 * selected and the map is tilted. While navigating only the 3D navigation view
 * draws them, in navigation mode (immersive navigation spec §7.2). The tilt
 * fade updates at most every 100 ms while the camera tilts and exactly when it
 * settles.
 */
export function useMapDetailsActive(map: MaplibreMap | null): MapDetailsActivation {
  const selected = useOverlayLayerVisible("3d-buildings");
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const sceneActive = useNavigationSceneStore((s) => s.active);
  const satellite = useLayerStore((s) => s.activeLayer) === "satellite";
  const [camera, setCamera] = useState(() => ({
    pitch: map?.getPitch() ?? 0,
    zoom: map?.getZoom() ?? 0,
  }));

  useEffect(() => {
    if (!map) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      clearTimeout(timer);
      timer = undefined;
      last = Date.now();
      setCamera((previous) => {
        const next = { pitch: map.getPitch(), zoom: map.getZoom() };
        return previous.pitch === next.pitch && previous.zoom === next.zoom ? previous : next;
      });
    };
    const throttled = () => {
      if (timer) return;
      const wait = FADE_THROTTLE_MS - (Date.now() - last);
      if (wait <= 0) sync();
      else timer = setTimeout(sync, wait);
    };
    sync();
    map.on("pitch", throttled);
    map.on("zoom", throttled);
    map.on("moveend", sync);
    return () => {
      clearTimeout(timer);
      map.off("pitch", throttled);
      map.off("zoom", throttled);
      map.off("moveend", sync);
    };
  }, [map]);

  return {
    active: selected && camera.pitch > TILT_THRESHOLD && (!navigating || sceneActive),
    mode: navigating && sceneActive ? "navigation" : "full",
    zoom: camera.zoom,
    pitchFade: pitchFadeOf(camera.pitch),
    satellite,
  };
}
