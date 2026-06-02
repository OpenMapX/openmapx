import { useNavigationStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";

const PITCH: Record<string, number> = {
  driving: 55,
  cycling: 35,
  walking: 0,
  transit: 0,
  flying: 0,
};
const CAMERA_EASE_DURATION_MS = 350;

/**
 * Drive the map camera to follow the snapped position while navigating in
 * "follow" mode. A user gesture (handled by the caller flipping cameraMode to
 * "free") suspends this; recenter flips it back.
 */
export function useFollowCamera(map: maplibregl.Map | null): void {
  const progress = useNavigationStore((s) => s.progress);
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const status = useNavigationStore((s) => s.status);
  const mode = useNavigationStore((s) => s.mode);

  useEffect(() => {
    if (!map || status === "idle" || cameraMode !== "follow" || !progress) return;
    map.easeTo(
      {
        center: progress.snapped,
        bearing: map.getBearing(),
        pitch: PITCH[mode] ?? 0,
        zoom: Math.max(map.getZoom(), 16),
        duration: CAMERA_EASE_DURATION_MS,
      },
      { programmatic: true },
    );
  }, [map, status, cameraMode, progress, mode]);

  // A user pan/rotate gesture drops follow mode; the RecenterFab restores it.
  // `dragstart`/`rotatestart` only fire from user interaction (programmatic
  // easeTo emits movestart, not dragstart), so no programmatic-flag check is needed.
  useEffect(() => {
    if (!map || status === "idle") return;
    const onUserGesture = () => useNavigationStore.getState().setCameraMode("free");
    map.on("dragstart", onUserGesture);
    map.on("rotatestart", onUserGesture);
    return () => {
      map.off("dragstart", onUserGesture);
      map.off("rotatestart", onUserGesture);
    };
  }, [map, status]);
}
