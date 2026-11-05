"use client";
import {
  cumulativeDistances,
  positionAt,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { getCameraPaddingTarget, subscribeCameraPaddingTarget } from "@/lib/cameraPadding";
import { prefersReducedMotion } from "@/lib/reducedMotion";

/** Follow actual rider fixes, using walking framing only on an active walk. */
export function useTransitFollowCamera() {
  const ctx = useMapOptional();
  const map = ctx?.mapRef?.current ?? null;
  const active = useNavigationStore((s) => s.kind === "transit" && s.status === "navigating");
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const progress = useNavigationStore((s) => s.transitProgress);
  const geometry = useNavigationStore(
    (s) => s.itinerary?.legs[s.transitProgress?.currentLegIndex ?? 0]?.geometry?.coordinates,
  );
  const northUp = useSettingsStore((s) => s.mapNorthUp);
  const line = useMemo(
    () =>
      geometry && geometry.length > 1 ? { geometry, cum: cumulativeDistances(geometry) } : null,
    [geometry],
  );
  const framing = useRef<"walking" | "ride" | null>(null);
  const following = useRef(false);
  const userZoomed = useRef(false);
  const bearing = useRef(0);
  const touching = useRef(false);
  const suspendedUntil = useRef(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resume = useRef<() => void>(() => {});
  const follow = useCallback(() => {
    const s = useNavigationStore.getState();
    const p = s.transitProgress;
    if (!map || s.kind !== "transit" || s.status !== "navigating") {
      following.current = false;
      framing.current = null;
      userZoomed.current = false;
      return;
    }
    if (s.cameraMode !== "follow") {
      following.current = false;
      return;
    }
    if (touching.current || Date.now() < suspendedUntil.current) return;
    if (!p?.position || !p.positionTimestampMs || Date.now() - p.positionTimestampMs > 30000)
      return;
    const walking =
      s.itinerary?.legs[p.currentLegIndex]?.mode === "walking" &&
      (p.phase === "walking" || p.phase === "transferring");
    const nextFraming = walking ? "walking" : "ride";
    const changed = framing.current !== null && framing.current !== nextFraming;
    if (changed) userZoomed.current = false;
    let zoom = map.getZoom();
    if (!userZoomed.current && (changed || !following.current))
      zoom = changed ? (walking ? 17 : 15) : Math.max(zoom, walking ? 17 : 15);
    if (!walking || northUp) bearing.current = 0;
    else if (line && p.confidence === "gps" && p.deviationMeters <= 30) {
      bearing.current = positionAt(
        line.geometry,
        line.cum,
        p.fractionAlongLeg * (line.cum.at(-1) ?? 0),
      ).bearing;
    }
    const padding = getCameraPaddingTarget(map);
    // Put the walker below the visible area's centre so the approaching turn
    // stays in view above the location dot, clear of the instruction banner.
    const walkingPadding = walking
      ? {
          ...padding,
          top:
            padding.top +
            Math.max(0, map.getCanvas().clientHeight - padding.top - padding.bottom) * 0.4,
        }
      : padding;
    map.easeTo(
      {
        center: p.position,
        zoom,
        pitch: 0,
        bearing: bearing.current,
        padding: walkingPadding,
        duration: prefersReducedMotion() ? 0 : 350,
      },
      { programmatic: true },
    );
    following.current = true;
    framing.current = nextFraming;
  }, [map, line, northUp]);
  resume.current = follow;
  // biome-ignore lint/correctness/useExhaustiveDependencies: these subscriptions trigger an atomic read of the latest store in follow.
  useEffect(() => {
    follow();
  }, [follow, active, cameraMode, progress]);
  useEffect(
    () => (map && active ? subscribeCameraPaddingTarget(map, follow) : undefined),
    [map, active, follow],
  );
  useEffect(() => {
    if (!map || !active) return;
    const programmatic = (event: unknown) =>
      !!event &&
      typeof event === "object" &&
      "programmatic" in event &&
      event.programmatic === true;
    const suspend = () => {
      suspendedUntil.current = Date.now() + 350;
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = setTimeout(() => {
        resumeTimer.current = null;
        if (!touching.current) resume.current();
      }, 350);
    };
    const move = (event?: unknown) => {
      if (!programmatic(event)) suspend();
    };
    const release = (event?: unknown) => {
      if (programmatic(event)) return;
      suspend();
      useNavigationStore.getState().setCameraMode("free");
    };
    const zoom = (event?: unknown) => {
      if (!programmatic(event)) {
        userZoomed.current = true;
        suspend();
      }
    };
    const down = () => {
      touching.current = true;
      suspend();
    };
    const up = (event?: unknown) => {
      if (
        (event as { originalEvent?: { touches?: { length: number } } })?.originalEvent?.touches
          ?.length
      )
        return;
      if (!touching.current) return;
      touching.current = false;
      suspend();
    };
    const listeners = {
      dragstart: release,
      rotatestart: release,
      pitchstart: release,
      zoomstart: zoom,
      zoom: move,
      move,
      wheel: move,
      touchstart: down,
      mousedown: down,
      touchend: up,
      touchcancel: up,
      mouseup: up,
    };
    const events = Object.keys(listeners) as Array<keyof typeof listeners>;
    for (const event of events) map.on(event, listeners[event]);
    document.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      for (const event of events) map.off(event, listeners[event]);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
      touching.current = false;
      suspendedUntil.current = 0;
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
      requestAnimationFrame(() => {
        if (useNavigationStore.getState().status === "idle")
          map.setPadding?.(getCameraPaddingTarget(map));
      });
    };
  }, [map, active]);
}
