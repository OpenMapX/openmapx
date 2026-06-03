import type { Route } from "@integrations/routing/types";
import type { LngLat } from "@openmapx/core";
import {
  cumulativeDistances,
  positionAt,
  stepDeadReckon,
  useNavigationStore,
} from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMapOptional } from "@/lib/MapContext";

const PITCH: Record<string, number> = {
  driving: 55,
  cycling: 35,
  walking: 0,
  transit: 0,
  flying: 0,
};
// Zoom applied when (re)entering follow mode; afterwards the user's zoom is kept.
const NAV_ENTER_ZOOM = 16;
// Establish zoom/pitch on enter; the per-frame loop holds off the camera until
// this short tilt-in settles so it doesn't cancel the easeTo.
const ENTER_EASE_MS = 350;
const SETTLE_MS = ENTER_EASE_MS + 20;
// First-order filter constants (seconds): position chase, forward-prediction
// cap, and a slightly snappier bearing so turns track without spinning.
const POS_TAU = 0.45;
const MAX_LEAD = 1.5;
const BEARING_TAU = 0.35;

// A bold navigation chevron pointing "up" (north) at rotation 0. Created with
// rotationAlignment: "map" and rotated by the travel bearing, so it points along
// the direction of travel and turns with the map (course-up).
const CHEVRON_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 2 L28 30 L17 23 L6 30 Z" fill="#1a73e8" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
</svg>`;

/** Ease an angle (deg) toward a target along the shortest arc. */
function easeAngle(current: number, target: number, alpha: number): number {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * alpha + 360) % 360;
}

interface RouteLine {
  route: Route;
  cum: number[];
  lengthMeters: number;
}

interface FixTarget {
  fixAlongMeters: number;
  speedMps: number;
  fixAtMs: number;
}

/**
 * Drive the heading puck and the follow camera from one shared, dead-reckoned
 * pose. A `requestAnimationFrame` loop advances an along-route distance toward
 * where the traveller actually is (predicting forward at the fix speed between
 * GPS fixes), then places the puck there and — in follow mode — keeps the camera
 * centred and course-up. Because puck and camera read the same smoothed pose
 * they stay locked; because the motion is continuous the marker glides instead
 * of snapping each fix.
 *
 * A user pan/rotate gesture drops to "free" mode (camera released, puck keeps
 * moving); the recenter control flips back to "follow".
 */
export function useNavCamera(): void {
  const ctx = useMapOptional();
  const mapRef = ctx?.mapRef ?? null;
  const mapReady = ctx?.mapReady ?? false;

  const status = useNavigationStore((s) => s.status);
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const mode = useNavigationStore((s) => s.mode);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);

  const markerRef = useRef<maplibregl.Marker | null>(null);
  const lineRef = useRef<RouteLine | null>(null);
  const targetRef = useRef<FixTarget | null>(null);
  // null = "snap to the next fix" (route just (re)started or changed).
  const displayedRef = useRef<number | null>(null);
  const bearingRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const settleUntilRef = useRef(0);

  const active = status === "navigating" || status === "rerouting";

  // Create the heading-puck marker once the map is ready; remove on unmount.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !mapReady || markerRef.current) return;
    let destroyed = false;
    import("maplibre-gl").then(({ default: maplibregl }) => {
      if (destroyed || markerRef.current) return;
      const el = document.createElement("div");
      el.style.cssText =
        "width:34px;height:34px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45));";
      el.innerHTML = CHEVRON_SVG;
      markerRef.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
        rotationAlignment: "map",
      }).setLngLat([0, 0]);
    });
    return () => {
      destroyed = true;
    };
  }, [mapRef, mapReady]);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  // Cache cumulative distances per route; reset the displayed position so the
  // puck snaps onto a fresh route (e.g. after a reroute) rather than gliding
  // across unrelated geometry.
  useEffect(() => {
    lineRef.current = route
      ? { route, cum: cumulativeDistances(route.geometry), lengthMeters: route.distance }
      : null;
    displayedRef.current = null;
    bearingRef.current = null;
    targetRef.current = null;
  }, [route]);

  // Record each new fix as the dead-reckoning target, stamped with its arrival
  // time so the loop can predict forward from it.
  useEffect(() => {
    if (!progress) return;
    targetRef.current = {
      fixAlongMeters: progress.alongMeters,
      speedMps: progress.speedMps,
      fixAtMs: performance.now(),
    };
    if (displayedRef.current === null) {
      displayedRef.current = progress.alongMeters;
      bearingRef.current = progress.bearing;
    }
  }, [progress]);

  // (Re)entering follow: establish zoom + pitch with a short ease, then let the
  // per-frame loop take over centre/bearing once it settles.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !active || cameraMode !== "follow") return;
    const prog = useNavigationStore.getState().progress;
    if (prog && displayedRef.current === null) {
      displayedRef.current = prog.alongMeters;
      bearingRef.current = prog.bearing;
    }
    map.easeTo(
      {
        zoom: Math.max(map.getZoom(), NAV_ENTER_ZOOM),
        pitch: PITCH[mode] ?? 0,
        duration: ENTER_EASE_MS,
      },
      { programmatic: true },
    );
    settleUntilRef.current = performance.now() + SETTLE_MS;
  }, [mapRef, active, cameraMode, mode]);

  // The animation loop: glide the puck and (in follow) the camera every frame.
  useEffect(() => {
    if (!active) {
      lastFrameRef.current = null;
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const map = mapRef?.current;
      const marker = markerRef.current;
      const line = lineRef.current;
      const target = targetRef.current;
      if (!map || !marker || !line || !target || displayedRef.current === null) return;

      const now = performance.now();
      const dt = lastFrameRef.current === null ? 0 : (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;

      displayedRef.current = stepDeadReckon(
        displayedRef.current,
        {
          fixAlongMeters: target.fixAlongMeters,
          speedMps: target.speedMps,
          ageSeconds: (now - target.fixAtMs) / 1000,
        },
        dt,
        { tauSeconds: POS_TAU, maxLeadSeconds: MAX_LEAD, routeLengthMeters: line.lengthMeters },
      );

      const { point, bearing } = positionAt(line.route.geometry, line.cum, displayedRef.current);
      const bearingAlpha = 1 - Math.exp(-Math.max(dt, 0) / BEARING_TAU);
      bearingRef.current = easeAngle(bearingRef.current ?? bearing, bearing, bearingAlpha);
      const brg = bearingRef.current;

      marker
        .setLngLat(point as LngLat)
        .setRotation(brg)
        .addTo(map);

      const camMode = useNavigationStore.getState().cameraMode;
      if (camMode === "follow" && now >= settleUntilRef.current) {
        map.jumpTo({ center: point as LngLat, bearing: brg }, { programmatic: true });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, mapRef]);

  // Hide the puck when not actively navigating.
  useEffect(() => {
    if (!active) markerRef.current?.remove();
  }, [active]);

  // A real user pan/rotate gesture releases the camera; our own programmatic
  // easeTo/jumpTo pass `{ programmatic: true }` so they don't trip this.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !active) return;
    const onUserGesture = (e: { programmatic?: boolean }) => {
      if (e?.programmatic) return;
      useNavigationStore.getState().setCameraMode("free");
    };
    map.on("dragstart", onUserGesture);
    map.on("rotatestart", onUserGesture);
    return () => {
      map.off("dragstart", onUserGesture);
      map.off("rotatestart", onUserGesture);
    };
  }, [mapRef, active]);
}
