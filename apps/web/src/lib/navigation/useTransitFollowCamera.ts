"use client";
import { useNavigationStore } from "@openmapx/core";
import { useCallback, useEffect, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { getCameraPaddingTarget, subscribeCameraPaddingTarget } from "@/lib/cameraPadding";
/** Both browser fixes and native snapshots follow the same actual rider position. */
export function useTransitFollowCamera() {
  const ctx = useMapOptional();
  const map = ctx?.mapRef?.current ?? null;
  const active = useNavigationStore((s) => s.kind === "transit" && s.status === "navigating");
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const position = useNavigationStore((s) => s.transitProgress?.position);
  const timestamp = useNavigationStore((s) => s.transitProgress?.positionTimestampMs);
  const following = useRef(false);
  const follow = useCallback(() => {
    const s = useNavigationStore.getState();
    const p = s.transitProgress;
    if (!map || s.kind !== "transit" || s.status !== "navigating" || s.cameraMode !== "follow") {
      following.current = false;
      return;
    }
    if (!p?.position || !p.positionTimestampMs || Date.now() - p.positionTimestampMs > 30000)
      return;
    map.easeTo(
      {
        center: p.position,
        zoom: following.current ? map.getZoom() : Math.max(map.getZoom(), 15),
        pitch: 0,
        bearing: 0,
        padding: getCameraPaddingTarget(map),
        duration: 350,
      },
      { programmatic: true },
    );
    following.current = true;
  }, [map]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: position and camera mode are the follow target; the callback reads the current store atomically.
  useEffect(() => {
    follow();
  }, [follow, active, cameraMode, position, timestamp]);
  useEffect(
    () => (map && active ? subscribeCameraPaddingTarget(map, follow) : undefined),
    [map, active, follow],
  );
  useEffect(() => {
    if (!map || !active) return;
    const release = (event?: unknown) => {
      if (
        !event ||
        typeof event !== "object" ||
        !("programmatic" in event) ||
        event.programmatic !== true
      )
        useNavigationStore.getState().setCameraMode("free");
    };
    map.on("dragstart", release);
    map.on("rotatestart", release);
    map.on("pitchstart", release);
    return () => {
      map.off("dragstart", release);
      map.off("rotatestart", release);
      map.off("pitchstart", release);
      requestAnimationFrame(() => {
        if (useNavigationStore.getState().status === "idle")
          map.setPadding?.(getCameraPaddingTarget(map));
      });
    };
  }, [map, active]);
}
