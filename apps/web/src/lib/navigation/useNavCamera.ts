import type { Route } from "@integrations/routing/types";
import type { LngLat } from "@openmapx/core";
import {
  cumulativeDistances,
  positionAt,
  stepDeadReckon,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import {
  getCameraPaddingTarget,
  type ResolvedPadding,
  subscribeCameraPaddingTarget,
} from "@/lib/cameraPadding";
import { prefersReducedMotion } from "@/lib/reducedMotion";
import {
  CAMERA_PADDING_EPSILON,
  type CameraPose,
  cameraPoseChanged,
  type PuckPose,
  puckPoseChanged,
  SETTLED_FRAMES_BEFORE_SLEEP,
  shouldKeepAnimating,
} from "./navCameraScheduler";

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
// Auto-zoom eases gently toward a speed-derived zoom — until the user takes
// zoom control. While a user camera gesture is in flight the follow loop is
// suspended (it must not run jumpTo, which calls stop() and would cancel the
// gesture) until this long after the last user camera event.
const ZOOM_TAU = 1.6;
// Chrome that moves under the map retargets the padding; the camera follows it
// briskly enough to look attached to the chrome rather than to lag behind it.
const PADDING_TAU = 0.2;
const USER_CAM_SUSPEND_MS = 350;

type CameraActivityEvent = maplibregl.MapMovementEvent | maplibregl.MapWheelEvent;

function isProgrammaticCameraEvent(event: CameraActivityEvent): boolean {
  // MapLibre merges the `eventData` argument from jumpTo/easeTo onto emitted
  // events at runtime, but intentionally does not include application-owned
  // fields in its event types.
  return "programmatic" in event && event.programmatic === true;
}

/**
 * Target follow-zoom for a ground speed: close in when slow/stopped, pull back
 * at speed to show more road ahead. ~17 at a standstill → ~14 at motorway speed.
 */
function targetZoomForSpeed(speedMps: number): number {
  const z = 17 - (Math.max(speedMps, 0) / 33) * 3;
  return Math.max(14, Math.min(17, z));
}

// A bold navigation chevron, seated in a white disc, pointing "up" (north) at
// rotation 0. Created with rotationAlignment: "map" and rotated by the travel
// bearing, so it points along the direction of travel and turns with the map
// (course-up).
const PUCK_PX = 48;
const CHEVRON_SVG = `<svg width="${PUCK_PX}" height="${PUCK_PX}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="24" r="20" fill="#ffffff"/>
  <path d="M24 11 L34 36 L24 30 L14 36 Z" fill="#1a73e8" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

/**
 * Ease every edge toward the target, snapping to it once the tail of the ease
 * has become too fine for the loop to publish.
 *
 * The frames the loop still has before it sleeps cover
 * `1 - (1 - alpha) ** SETTLED_FRAMES_BEFORE_SLEEP` of whatever distance is
 * left. Once that fraction of it falls under the publication threshold, every
 * one of those frames sends nothing, the loop sleeps part-way through the ease,
 * and the framing stays permanently short of the chrome that asked for it. So
 * the snap is tied to the sleep rule rather than to a frame count of its own:
 * it spends the remainder in one step the loop will publish. On the dt = 0
 * frame after a wake nothing has moved yet, so only an ease that has genuinely
 * arrived may snap.
 */
function easePadding(
  from: maplibregl.PaddingOptions,
  to: ResolvedPadding,
  alpha: number,
): ResolvedPadding {
  const step = (a: number, b: number) => a + (b - a) * alpha;
  const eased = {
    top: step(from.top ?? 0, to.top),
    bottom: step(from.bottom ?? 0, to.bottom),
    left: step(from.left ?? 0, to.left),
    right: step(from.right ?? 0, to.right),
  };
  const beforeSleep = 1 - (1 - alpha) ** SETTLED_FRAMES_BEFORE_SLEEP;
  const snapWithin = alpha > 0 ? CAMERA_PADDING_EPSILON / beforeSleep : CAMERA_PADDING_EPSILON;
  const settled =
    Math.abs(eased.top - to.top) < snapWithin &&
    Math.abs(eased.bottom - to.bottom) < snapWithin &&
    Math.abs(eased.left - to.left) < snapWithin &&
    Math.abs(eased.right - to.right) < snapWithin;
  return settled ? { ...to } : eased;
}

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
 *
 * The loop only runs while something can visibly move. Attachment, pose
 * integration and publication to MapLibre are three separate jobs: the marker is
 * attached once per map (MapLibre's `addTo` is a teardown/rebind, not a move),
 * setters and `jumpTo` run only for poses that changed enough to see, and a
 * frame that publishes nothing twice over stops asking for frames until an input
 * wakes it again.
 */
export function useNavCamera(): void {
  const ctx = useMapOptional();
  const mapRef = ctx?.mapRef ?? null;
  const mapReady = ctx?.mapReady ?? false;
  const styleVersion = ctx?.styleVersion ?? 0;

  const status = useNavigationStore((s) => s.status);
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const coasting = useNavigationStore((s) => s.coasting);
  const mode = useNavigationStore((s) => s.mode);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  // Subscribed rather than read imperatively: flipping north-up must re-orient a
  // camera that has already come to rest.
  const mapNorthUp = useSettingsStore((s) => s.mapNorthUp);

  const markerRef = useRef<maplibregl.Marker | null>(null);
  // The map the marker is currently attached to, so attachment happens on a map
  // change and nowhere else. Ownership is tracked here rather than read back off
  // the marker: MapLibre exposes it only privately.
  const markerMapRef = useRef<maplibregl.Map | null>(null);
  const lineRef = useRef<RouteLine | null>(null);
  const targetRef = useRef<FixTarget | null>(null);
  // null = "snap to the next fix" (route just (re)started or changed).
  const displayedRef = useRef<number | null>(null);
  const bearingRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const settleUntilRef = useRef(0);
  // Last puck pose written to the marker, and last camera pose applied via
  // jumpTo. They let the per-frame loop skip a redundant marker write or camera
  // transform + repaint while the puck is stationary (e.g. at a light).
  const lastPuckRef = useRef<PuckPose | null>(null);
  const lastCamRef = useRef<CameraPose | null>(null);
  // The single outstanding animation frame, the frame body it should run, and
  // how many frames in a row have published nothing.
  const rafRef = useRef(0);
  const runFrameRef = useRef<(() => void) | null>(null);
  const settledFramesRef = useRef(0);
  // Eased follow-zoom; whether the user has taken manual zoom control (then the
  // loop follows at their zoom instead of auto-zooming); and the time until
  // which a recent user camera gesture suspends the follow loop.
  const displayedZoomRef = useRef<number | null>(null);
  // Eased camera padding, so a chrome change slides the framing instead of
  // stepping it. null = "take whatever the map currently shows".
  const displayedPaddingRef = useRef<ResolvedPadding | null>(null);
  // Where that ease is heading. Resolving it measures the map container, and a
  // frame has already written the puck's transform by then — reading layout
  // there would force a reflow every frame. So it is cached until one of its
  // inputs announces a change; null = "recompute on the next frame".
  const paddingTargetRef = useRef<ResolvedPadding | null>(null);
  const userZoomedRef = useRef(false);
  const userCamActivityUntilRef = useRef(0);
  // True while a finger/mouse button is down on the map. The follow loop yields
  // for the whole interaction so its per-frame jumpTo can't reset MapLibre's
  // in-progress gesture before it crosses the pan/zoom threshold — the reason a
  // pinch or drag wouldn't take hold while the puck (and camera) were moving.
  const userInteractingRef = useRef(false);

  const active = status === "navigating" || status === "rerouting";

  // Ask for one animation frame, if one isn't already booked and the loop is
  // mounted. Every input that can change the visible pose calls this, which is
  // what lets a frame that found nothing to do simply stop.
  const requestFrame = useCallback(() => {
    if (rafRef.current || !runFrameRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      // Clear the handle before the work so the frame can book its successor.
      rafRef.current = 0;
      runFrameRef.current?.();
    });
  }, []);

  // Create the heading-puck marker once the map is ready; remove on unmount.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !mapReady || markerRef.current) return;
    let destroyed = false;
    void import("maplibre-gl")
      .then((maplibregl) => {
        if (destroyed || markerRef.current) return;
        const el = document.createElement("div");
        el.style.cssText = `width:${PUCK_PX}px;height:${PUCK_PX}px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45));`;
        el.innerHTML = CHEVRON_SVG;
        markerRef.current = new maplibregl.Marker({
          element: el,
          anchor: "center",
          rotationAlignment: "map",
        }).setLngLat([0, 0]);
        // The puck can arrive long after the loop started (or after it went back
        // to sleep waiting for one): wake the frame that will attach it.
        requestFrame();
      })
      .catch(() => undefined);
    return () => {
      destroyed = true;
    };
  }, [mapRef, mapReady, requestFrame]);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      markerMapRef.current = null;
    };
  }, []);

  // Fade the puck while coasting so an extrapolated position reads as an estimate
  // rather than a live fix.
  useEffect(() => {
    const el = markerRef.current?.getElement();
    if (el) el.style.opacity = coasting ? "0.5" : "1";
  }, [coasting]);

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
    lastPuckRef.current = null;
    lastCamRef.current = null;
    displayedZoomRef.current = null;
    displayedPaddingRef.current = null;
    requestFrame();
  }, [route, requestFrame]);

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
    requestFrame();
  }, [progress, requestFrame]);

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
    // Respect a user-chosen zoom on re-entry (recenter); otherwise establish the
    // default follow zoom.
    const enterZoom = userZoomedRef.current
      ? map.getZoom()
      : Math.max(map.getZoom(), NAV_ENTER_ZOOM);
    const enterPadding = getCameraPaddingTarget(map);
    map.easeTo(
      {
        zoom: enterZoom,
        pitch: PITCH[mode] ?? 0,
        padding: enterPadding,
        duration: prefersReducedMotion() ? 0 : ENTER_EASE_MS,
      },
      { programmatic: true },
    );
    // Seed the eased follow-zoom and padding so the per-frame loop continues
    // from here.
    displayedZoomRef.current = enterZoom;
    displayedPaddingRef.current = enterPadding;
    paddingTargetRef.current = enterPadding;
    settleUntilRef.current = performance.now() + SETTLE_MS;
    // Forget the published poses: a recenter or a mode change is a
    // discontinuity, and the first frame after the ease must draw it.
    lastPuckRef.current = null;
    lastCamRef.current = null;
    requestFrame();
  }, [mapRef, active, cameraMode, mode, requestFrame]);

  // Chrome moving under the map (a sheet detent, a rewrapped banner) changes
  // the padding target; the next frame resolves it once and eases toward it.
  // This subscription covers every input of that target, which is what lets the
  // loop treat the cached one as good until told otherwise — so failing to bind
  // it does not merely drop a wake, it freezes the framing for the whole trip.
  // `styleVersion` is what announces a map: `mapRef` is a stable object, and a
  // rebuilt map neither clears `mapReady` nor re-runs anything else here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleVersion is the trigger for re-binding, not a value the body reads.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !active) return;
    return subscribeCameraPaddingTarget(map, () => {
      paddingTargetRef.current = null;
      requestFrame();
    });
  }, [mapRef, active, requestFrame, styleVersion]);

  // Inputs the loop reads imperatively rather than through a dependency: they
  // change what the next frame would draw, so each needs an explicit wake.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the values are the trigger, not an input to the body — the frame that runs re-reads them from the map and the stores.
  useEffect(() => {
    requestFrame();
  }, [requestFrame, cameraMode, coasting, mapReady, mapNorthUp, styleVersion]);

  // Coming back from a hidden tab: frames were throttled or stopped entirely
  // while the pose kept ageing.
  useEffect(() => {
    if (!active) return;
    const onVisibilityChange = () => requestFrame();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [active, requestFrame]);

  // The animation loop: glide the puck and (in follow) the camera, for as long
  // as either of them still has somewhere to go.
  useEffect(() => {
    if (!active) {
      lastFrameRef.current = null;
      settledFramesRef.current = 0;
      return;
    }
    const runFrame = () => {
      const now = performance.now();
      // Set by anything this frame actually sent to MapLibre. A frame that sends
      // nothing is a frame the user could not have seen.
      let published = false;
      const map = mapRef?.current;
      const marker = markerRef.current;
      const line = lineRef.current;
      const target = targetRef.current;

      if (map && marker && line && target && displayedRef.current !== null) {
        // A marker lives on one map at a time, and MapLibre's addTo() removes
        // and rebinds the element and its listeners — so it runs on attachment
        // only. A new map invalidates both published poses.
        const attaching = markerMapRef.current !== map;
        if (attaching) {
          lastPuckRef.current = null;
          lastCamRef.current = null;
          // A different container, so its measurements are not this map's.
          paddingTargetRef.current = null;
        }

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

        const puckPose: PuckPose = { lng: point[0], lat: point[1], bearing: brg };
        if (puckPoseChanged(lastPuckRef.current, puckPose)) {
          marker.setLngLat(point as LngLat).setRotation(brg);
          lastPuckRef.current = puckPose;
          published = true;
        }
        if (attaching) {
          marker.addTo(map);
          markerMapRef.current = map;
        }

        const camMode = useNavigationStore.getState().cameraMode;
        if (
          camMode !== "follow" ||
          now < settleUntilRef.current ||
          now < userCamActivityUntilRef.current ||
          userInteractingRef.current
        ) {
          // Released, still settling the enter-ease, or the user is actively
          // touching/panning/zooming: do NOT run jumpTo — it calls stop() and would
          // cancel the user's gesture or zoom animation. Re-center on a free frame.
          lastCamRef.current = null;
        } else {
          // Follow center + bearing. Auto-zoom toward the speed-derived target,
          // unless the user has taken zoom control — then leave zoom untouched so
          // navigation continues at their chosen zoom.
          const commandZoom = !userZoomedRef.current;
          let zoom = map.getZoom();
          if (commandZoom) {
            const speed = useNavigationStore.getState().progress?.speedMps ?? 0;
            const base = displayedZoomRef.current ?? zoom;
            const zAlpha = 1 - Math.exp(-Math.max(dt, 0) / ZOOM_TAU);
            displayedZoomRef.current = base + (targetZoomForSpeed(speed) - base) * zAlpha;
            zoom = displayedZoomRef.current;
          }
          // The follow loop owns padding for as long as it owns the camera, so
          // the sync component stays out and the two can't ease against each
          // other.
          let targetPadding = paddingTargetRef.current;
          if (!targetPadding) {
            targetPadding = getCameraPaddingTarget(map);
            paddingTargetRef.current = targetPadding;
          }
          const pAlpha = 1 - Math.exp(-Math.max(dt, 0) / PADDING_TAU);
          const padding = easePadding(
            displayedPaddingRef.current ?? map.getPadding(),
            targetPadding,
            pAlpha,
          );
          displayedPaddingRef.current = padding;
          // North-up keeps the map oriented north (the puck still rotates to the
          // travel bearing); the default course-up rotates the map to it.
          const cameraBearing = useSettingsStore.getState().mapNorthUp ? 0 : brg;
          const camPose: CameraPose = {
            lng: point[0],
            lat: point[1],
            bearing: cameraBearing,
            zoom,
            padding,
          };
          if (cameraPoseChanged(lastCamRef.current, camPose, commandZoom)) {
            const camOpts: maplibregl.JumpToOptions = {
              center: point as LngLat,
              bearing: cameraBearing,
              padding,
            };
            if (commandZoom) camOpts.zoom = zoom;
            map.jumpTo(camOpts, { programmatic: true });
            lastCamRef.current = camPose;
            published = true;
          }
        }
      }

      settledFramesRef.current = published ? 0 : settledFramesRef.current + 1;
      // The enter-follow ease and the post-gesture grace window both end in a
      // camera hand-back that no input would otherwise announce, so the loop
      // runs through them whatever the pose is doing.
      const holdUntilMs = Math.max(settleUntilRef.current, userCamActivityUntilRef.current);
      if (
        shouldKeepAnimating({
          publishedThisFrame: published,
          settledFrames: settledFramesRef.current,
          holdUntilMs,
          nowMs: now,
        })
      ) {
        requestFrame();
      } else {
        // Going to sleep: drop the frame timestamp, or the first frame after the
        // wake would integrate a dt spanning the whole idle period and jump the
        // dead-reckoned pose forward. That first frame therefore runs at dt = 0
        // and cannot move anything, so the settled count starts over too —
        // otherwise the wake frame would immediately put the loop back to sleep.
        lastFrameRef.current = null;
        settledFramesRef.current = 0;
      }
    };

    runFrameRef.current = runFrame;
    requestFrame();
    return () => {
      runFrameRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastFrameRef.current = null;
      settledFramesRef.current = 0;
    };
  }, [active, mapRef, requestFrame]);

  // Hide the puck when not actively navigating, and clear user-control state so
  // the next trip starts in auto-follow. The padding is left where it is: the
  // sync component reconciles it against whatever chrome is now on screen.
  useEffect(() => {
    if (!active) {
      markerRef.current?.remove();
      markerMapRef.current = null;
      lastPuckRef.current = null;
      lastCamRef.current = null;
      displayedPaddingRef.current = null;
      paddingTargetRef.current = null;
      userZoomedRef.current = false;
      userCamActivityUntilRef.current = 0;
      userInteractingRef.current = false;
    }
  }, [active]);

  // Honour user camera gestures during navigation. A pan/rotate/pitch releases
  // follow (the recenter control resumes it); a zoom keeps following but hands
  // zoom control to the user. While any gesture is in flight the follow loop is
  // suspended so it can't fight it. Our own programmatic moves pass
  // `{ programmatic: true }` and are ignored.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !active) return;
    const suspend = () => {
      userCamActivityUntilRef.current = performance.now() + USER_CAM_SUSPEND_MS;
      // Stay awake across the whole suspension window: its expiry is what hands
      // the camera back, and nothing else would announce it.
      requestFrame();
    };
    const onPanRotatePitch = (event: maplibregl.MapMovementEvent) => {
      if (isProgrammaticCameraEvent(event)) return;
      suspend();
      useNavigationStore.getState().setCameraMode("free");
    };
    const onZoomStart = (event: maplibregl.MapMovementEvent) => {
      if (isProgrammaticCameraEvent(event)) return;
      userZoomedRef.current = true;
      suspend();
    };
    // Continuous events keep the loop suspended for the whole gesture.
    const onUserMove = (event: CameraActivityEvent) => {
      if (isProgrammaticCameraEvent(event)) return;
      suspend();
    };
    // Yield the moment a pointer goes down — before MapLibre has classified the
    // gesture as a pan or zoom — and for the whole time it stays down. Without
    // this the moving follow loop keeps calling jumpTo and the nascent gesture
    // never crosses its threshold (dragstart/zoomstart never fire).
    const onPointerDown = () => {
      userInteractingRef.current = true;
      suspend();
    };
    const onPointerUp = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      // A multi-touch gesture fires touchend as each finger lifts; only release
      // once none remain.
      if ("touches" in event.originalEvent && event.originalEvent.touches.length > 0) return;
      userInteractingRef.current = false;
      requestFrame();
    };
    map.on("dragstart", onPanRotatePitch);
    map.on("rotatestart", onPanRotatePitch);
    map.on("pitchstart", onPanRotatePitch);
    map.on("zoomstart", onZoomStart);
    map.on("zoom", onUserMove);
    map.on("move", onUserMove);
    map.on("touchstart", onPointerDown);
    map.on("mousedown", onPointerDown);
    map.on("touchend", onPointerUp);
    map.on("touchcancel", onPointerUp);
    map.on("mouseup", onPointerUp);
    map.on("wheel", onUserMove);
    return () => {
      map.off("dragstart", onPanRotatePitch);
      map.off("rotatestart", onPanRotatePitch);
      map.off("pitchstart", onPanRotatePitch);
      map.off("zoomstart", onZoomStart);
      map.off("zoom", onUserMove);
      map.off("move", onUserMove);
      map.off("touchstart", onPointerDown);
      map.off("mousedown", onPointerDown);
      map.off("touchend", onPointerUp);
      map.off("touchcancel", onPointerUp);
      map.off("mouseup", onPointerUp);
      map.off("wheel", onUserMove);
      userInteractingRef.current = false;
    };
  }, [mapRef, active, requestFrame]);
}
