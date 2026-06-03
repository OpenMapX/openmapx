"use client";

import { useNavigationStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

// A bold navigation chevron pointing "up" (north) at rotation 0. The marker is
// created with rotationAlignment: "map" and rotated by the travel bearing, so
// it points along the direction of travel and turns with the map.
const CHEVRON_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 2 L28 30 L17 23 L6 30 Z" fill="#1a73e8" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
</svg>`;

export function NavHeadingPuck() {
  const { mapRef, mapReady } = useMap();
  const progress = useNavigationStore((s) => s.progress);
  const status = useNavigationStore((s) => s.status);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Create the marker element once the map is ready.
  useEffect(() => {
    const map = mapRef.current;
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
        // Rotate with the map so the chevron tracks the world travel direction.
        rotationAlignment: "map",
      }).setLngLat([0, 0]);
    });

    return () => {
      destroyed = true;
    };
  }, [mapRef, mapReady]);

  // Remove the marker on unmount.
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  // Reposition + rotate to the travel bearing as the user moves.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    if (status === "idle" || status === "arrived" || !progress) {
      marker.remove();
      return;
    }
    marker.setLngLat(progress.snapped).setRotation(progress.bearing).addTo(map);
  }, [mapRef, status, progress]);

  return null;
}
