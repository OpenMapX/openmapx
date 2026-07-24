"use client";

import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useElevationHover } from "@/components/elevation/ElevationHoverContext";
import { useMap } from "@/lib/MapContext";

export function ElevationHoverMarker() {
  const { mapRef } = useMap();
  const { hoveredPoint } = useElevationHover();
  const markerRef = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!hoveredPoint) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    let cancelled = false;

    import("maplibre-gl").then(({ default: maplibregl }) => {
      if (cancelled || !mapRef.current) return;

      if (markerRef.current) {
        markerRef.current.setLngLat(hoveredPoint.lngLat);
        return;
      }

      const el = document.createElement("div");
      el.style.width = "14px";
      el.style.height = "14px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#43A047";
      el.style.border = "2px solid #fff";
      el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.3)";
      el.style.pointerEvents = "none";

      markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(hoveredPoint.lngLat)
        .addTo(mapRef.current);
    });

    return () => {
      cancelled = true;
    };
  }, [hoveredPoint, mapRef]);

  return null;
}
