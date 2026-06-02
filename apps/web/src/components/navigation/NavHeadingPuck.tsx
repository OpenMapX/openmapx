"use client";

import { useNavigationStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

export function NavHeadingPuck({ heading }: { heading: number | null }) {
  const { mapRef, mapReady } = useMap();
  const progress = useNavigationStore((s) => s.progress);
  const status = useNavigationStore((s) => s.status);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const coneRef = useRef<HTMLDivElement | null>(null);

  // Create the marker element once the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || markerRef.current) return;

    let destroyed = false;

    import("maplibre-gl").then(({ default: maplibregl }) => {
      if (destroyed || markerRef.current) return;

      const el = document.createElement("div");
      el.style.cssText = "width:22px;height:22px;position:relative;";
      const cone = document.createElement("div");
      cone.style.cssText =
        "position:absolute;left:50%;top:50%;width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:18px solid #1a73e8;transform-origin:50% 70%;transform:translate(-50%,-70%);";
      const dot = document.createElement("div");
      dot.style.cssText =
        "position:absolute;left:50%;top:50%;width:12px;height:12px;border-radius:50%;background:#1a73e8;border:2px solid #fff;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.4);";
      el.appendChild(cone);
      el.appendChild(dot);
      coneRef.current = cone;
      markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([
        0, 0,
      ]);
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
      coneRef.current = null;
    };
  }, []);

  // Reposition + rotate as the user moves.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    if (status === "idle" || !progress) {
      marker.remove();
      return;
    }
    marker.setLngLat(progress.snapped).addTo(map);
    if (coneRef.current && heading !== null) {
      coneRef.current.style.transform = `translate(-50%,-70%) rotate(${heading}deg)`;
    }
  }, [mapRef, status, progress, heading]);

  return null;
}
