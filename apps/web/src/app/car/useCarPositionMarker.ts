"use client";
import { useNavigationStore } from "@openmapx/core";
import type { CarPosition, CarViewport } from "@openmapx/core/navigation";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";

/** Zoom the idle car map opens at, close enough to read the streets around the car. */
export const CAR_IDLE_ZOOM = 16;
/** Below this the fix's bearing is noise, so the map keeps its rotation. */
const MOVING_MPS = 2;

/**
 * The car's position before a trip: a location dot, and a camera that follows it
 * until the driver pans. A trip draws its own puck from snapshots instead.
 */
export function useCarPositionMarker({
  position,
  stable,
}: {
  position: CarPosition | null;
  stable: CarViewport["stable"];
}) {
  const { mapRef, mapReady } = useMap();
  const following = useNavigationStore((s) => s.cameraMode === "follow");
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const centredRef = useRef(false);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!position) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    let cancelled = false;
    const lngLat: [number, number] = [position.lng, position.lat];
    void import("maplibre-gl").then((lib) => {
      if (cancelled) return;
      if (!markerRef.current) {
        const dot = document.createElement("div");
        dot.style.cssText =
          "width:22px;height:22px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);";
        markerRef.current = new lib.Marker({ element: dot, anchor: "center" });
      }
      markerRef.current.setLngLat(lngLat).addTo(map);
    });
    if (following) {
      const moving = (position.speedMps ?? 0) >= MOVING_MPS && position.bearing !== undefined;
      const first = !centredRef.current;
      centredRef.current = true;
      map.easeTo(
        {
          center: lngLat,
          zoom: first ? CAR_IDLE_ZOOM : map.getZoom(),
          bearing: moving ? position.bearing : map.getBearing(),
          pitch: 0,
          padding: stable,
          duration: first ? 0 : 900,
        },
        { programmatic: true },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [position, following, mapRef, mapReady, stable]);
}
