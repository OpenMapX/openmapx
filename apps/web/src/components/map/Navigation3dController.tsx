"use client";

import { NAV_CAMERA_PROFILE, useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";

/** How long a lowered pitch limit may wait for the camera to come down to it. */
const RESTORE_TIMEOUT_MS = 3000;
/** The ease that brings a camera nobody lowered down to the old limit. */
const EASE_DOWN_MS = 600;
/** Extra wait before lowering the limit if that ease was interrupted. */
const RESTORE_GRACE_MS = 400;

/**
 * Decides whether 3D navigation is active on the main map (immersive
 * navigation spec §7.2): a driving or motorcycle trip with the 3D view on. It
 * publishes that to the navigation scene store, which moves the 3D scene above
 * the route, and raises the map's pitch limit for the steeper 3D camera.
 * Lowering the limit again waits until the camera has eased down to it, so the
 * map never clamps the pitch with a jump. The car map does not mount this.
 */
export function Navigation3dController(): null {
  const { mapRef, mapReady, styleVersion } = useMap();
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const mode = useNavigationStore((s) => s.mode);
  const threeDView = useOverlayLayerVisible("3d-buildings");
  const active = navigating && (mode === "driving" || mode === "motorcycle") && threeDView;

  // The limit the map had before 3D navigation raised it.
  const savedRef = useRef<{ map: maplibregl.Map; maxPitch: number } | null>(null);

  useEffect(() => {
    useNavigationSceneStore.getState().setActive(active);
  }, [active]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (active) {
      if (savedRef.current?.map !== map) savedRef.current = { map, maxPitch: map.getMaxPitch() };
      map.setMaxPitch(NAV_CAMERA_PROFILE["3d"].maxPitch);
      return;
    }
    const saved = savedRef.current;
    if (!saved || saved.map !== map) return;
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      map.off("move", onMove);
      clearTimeout(timer);
      map.setMaxPitch(saved.maxPitch);
      savedRef.current = null;
    };
    const onMove = () => {
      if (map.getPitch() <= saved.maxPitch) restore();
    };
    // Nothing brought the camera down (the user owns a free camera pitched
    // above the old limit): ease it down rather than letting the limit snap
    // it, and lower the limit once it arrives, or shortly after regardless.
    let timer = setTimeout(() => {
      timer = setTimeout(restore, EASE_DOWN_MS + RESTORE_GRACE_MS);
      map.easeTo({ pitch: saved.maxPitch, duration: EASE_DOWN_MS });
    }, RESTORE_TIMEOUT_MS);
    map.on("move", onMove);
    onMove();
    return () => {
      if (done) return;
      map.off("move", onMove);
      clearTimeout(timer);
    };
  }, [active, mapReady, styleVersion, mapRef]);

  // Leaving the page ends 3D navigation at once.
  useEffect(
    () => () => {
      const saved = savedRef.current;
      if (saved) saved.map.setMaxPitch(saved.maxPitch);
      savedRef.current = null;
      useNavigationSceneStore.getState().setActive(false);
    },
    [],
  );

  return null;
}
