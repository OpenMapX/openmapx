"use client";

import { useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  activeCameraRequest,
  clearCameraRequest,
  lastInstantRequestAt,
  retargetCameraRequest,
} from "@/lib/cameraFraming";
import {
  getCameraPaddingTarget,
  paddingEquals,
  type ResolvedPadding,
  subscribeCameraPaddingTarget,
} from "@/lib/cameraPadding";
import { type MapEdge, publishMapObstruction } from "@/lib/mapObstructions";
import { prefersReducedMotion } from "@/lib/reducedMotion";

export const PADDING_EASE_MS = 250;
/** A padding change this soon after an instant framing request jumps as well. */
const INSTANT_AFTER_REQUEST_MS = 300;

const SAFE_AREA_EDGES: Array<{
  edge: MapEdge;
  property: "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight";
}> = [
  { edge: "top", property: "paddingTop" },
  { edge: "bottom", property: "paddingBottom" },
  { edge: "left", property: "paddingLeft" },
  { edge: "right", property: "paddingRight" },
];

type MoveEvent = maplibregl.MapMovementEvent & {
  programmatic?: boolean;
  paddingSync?: boolean;
  cameraRequest?: boolean;
};

function followCameraOwnsPadding(): boolean {
  const nav = useNavigationStore.getState();
  const active = nav.status === "navigating" || nav.status === "rerouting";
  return active && nav.kind === "ground" && nav.cameraMode === "follow";
}

/** Publishes the device safe-area insets by reading them off a hidden probe. */
function useSafeAreaObstructions(probe: HTMLDivElement | null) {
  useEffect(() => {
    if (!probe) return;
    const read = () => {
      const style = getComputedStyle(probe);
      for (const { edge, property } of SAFE_AREA_EDGES) {
        publishMapObstruction(`safe-area-${edge}`, edge, Number.parseFloat(style[property]) || 0);
      }
    };
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
      for (const { edge } of SAFE_AREA_EDGES) {
        publishMapObstruction(`safe-area-${edge}`, edge, null);
      }
    };
  }, [probe]);
}

/**
 * Keeps MapLibre's transform padding equal to the resolved obstruction
 * padding, so every camera operation frames against the visible viewport.
 * Never interrupts a user gesture, retargets the app's own in-flight framing
 * requests, and stays out of the way while the navigation follow loop owns
 * the camera.
 */
export function MapPaddingSync() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const [probe, setProbe] = useState<HTMLDivElement | null>(null);
  useSafeAreaObstructions(probe);

  // `styleVersion` is what announces a map: `mapRef` is a stable object, and a
  // rebuilt map neither clears `mapReady` nor re-runs anything else here, so
  // without it the listeners below stay bound to the removed one and every
  // later panel change silently frames nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleVersion is the trigger for re-binding, not a value the body reads.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let frame = 0;
    let scheduled = false;
    let userMoving = false;
    let pointerDown = false;
    let foreignMoving = false;
    let evaluated = false;
    /**
     * The next application jumps rather than eases (a window resize). Consumed
     * by whichever evaluation accounts for that resize, including one that
     * finds the target already on the map — left set there, it would make the
     * next ordinary panel change jump too.
     */
    let instantNext = false;
    /** Where this sync's own padding ease is headed, while it runs. */
    let easingTo: ResolvedPadding | null = null;

    const apply = () => {
      scheduled = false;
      // Resolving a target measures the container, and during ground follow the
      // answer is thrown away: `useNavCamera` owns the padding outright there,
      // and publishes a camera every frame, each one re-entering here.
      if (followCameraOwnsPadding()) return;
      // The first evaluation after the map is ready jumps; nothing is on screen
      // yet that an ease could be seen against.
      const firstEvaluation = !evaluated;
      evaluated = true;
      const target = getCameraPaddingTarget(map);
      // Mid-ease the map does not carry the target yet, so the comparison is
      // against where the ease is headed: it runs to its end untouched, and
      // only a target that moved under it starts a new one.
      if (paddingEquals(target, easingTo ?? map.getPadding())) {
        instantNext = false;
        return;
      }
      if (userMoving || pointerDown) return;
      const request = activeCameraRequest(map);
      if (request) {
        instantNext = false;
        if (!paddingEquals(request.padding, target)) retargetCameraRequest(map, request, target);
        return;
      }
      if (foreignMoving) return;
      const instant =
        firstEvaluation ||
        instantNext ||
        prefersReducedMotion() ||
        performance.now() - lastInstantRequestAt(map) < INSTANT_AFTER_REQUEST_MS;
      instantNext = false;
      const eventData = { programmatic: true, paddingSync: true };
      try {
        if (instant) {
          map.setPadding(target, eventData);
          return;
        }
        map.easeTo({ padding: target, duration: PADDING_EASE_MS }, eventData);
        // Recorded once the call returns: starting the ease stops whatever was
        // running and fires a synchronous `moveend`, whose handler clears this.
        easingTo = target;
      } catch {
        // A map removed mid-frame; the next target change tries again.
      }
    };
    // The pending flag is raised before the frame is requested, not derived
    // from the returned id: the callback can already have run by the time the
    // id lands back here.
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(apply);
    };

    const onMoveStart = (event: MoveEvent) => {
      if (event.programmatic) {
        if (!event.paddingSync && !event.cameraRequest) foreignMoving = true;
        return;
      }
      userMoving = true;
      clearCameraRequest(map);
    };
    const onMoveEnd = () => {
      userMoving = false;
      foreignMoving = false;
      easingTo = null;
      clearCameraRequest(map);
      schedule();
    };
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if ("touches" in event.originalEvent && event.originalEvent.touches.length > 0) return;
      pointerDown = false;
      schedule();
    };
    const onResize = () => {
      instantNext = true;
      schedule();
    };

    map.on("movestart", onMoveStart);
    map.on("moveend", onMoveEnd);
    map.on("mousedown", onPointerDown);
    map.on("touchstart", onPointerDown);
    map.on("mouseup", onPointerUp);
    map.on("touchend", onPointerUp);
    map.on("touchcancel", onPointerUp);
    map.on("resize", onResize);
    const unsubscribe = subscribeCameraPaddingTarget(map, schedule);
    schedule();

    return () => {
      unsubscribe();
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("mousedown", onPointerDown);
      map.off("touchstart", onPointerDown);
      map.off("mouseup", onPointerUp);
      map.off("touchend", onPointerUp);
      map.off("touchcancel", onPointerUp);
      map.off("resize", onResize);
      if (scheduled) cancelAnimationFrame(frame);
    };
  }, [mapRef, mapReady, styleVersion]);

  return (
    <div
      ref={setProbe}
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        visibility: "hidden",
        pointerEvents: "none",
        paddingTop: "var(--omx-safe-top)",
        paddingBottom: "var(--omx-safe-bottom)",
        paddingLeft: "var(--omx-safe-left)",
        paddingRight: "var(--omx-safe-right)",
      }}
    />
  );
}
