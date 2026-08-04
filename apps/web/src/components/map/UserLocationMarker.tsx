"use client";

import { useMapStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

export function UserLocationMarker() {
  const { mapReady, mapRef } = useMap();
  const userLocation = useMapStore((s) => s.userLocation);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!userLocation || !mapReady) return;

    let destroyed = false;

    import("maplibre-gl").then((maplibregl) => {
      if (destroyed || !mapRef.current) return;

      if (markerRef.current) {
        markerRef.current.setLngLat(userLocation);
        return;
      }

      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:relative;width:16px;height:16px;";

      // Outer pulsing ring
      const pulse = document.createElement("div");
      pulse.style.cssText = `
        position:absolute;
        inset:-4px;
        border-radius:50%;
        background:rgba(66,133,244,0.2);
        animation:loc-pulse 2s ease-out infinite;
      `;

      // Inner blue dot with white border
      const dot = document.createElement("div");
      dot.style.cssText = `
        position:absolute;
        inset:0;
        border-radius:50%;
        background:#4285F4;
        border:2px solid white;
        box-shadow:0 2px 6px rgba(0,0,0,0.35);
      `;

      wrapper.appendChild(pulse);
      wrapper.appendChild(dot);

      // Inject keyframes once
      if (!document.getElementById("loc-pulse-style")) {
        const style = document.createElement("style");
        style.id = "loc-pulse-style";
        style.textContent = `
          @keyframes loc-pulse {
            0%   { transform:scale(0.5); opacity:1; }
            100% { transform:scale(2);   opacity:0; }
          }
        `;
        document.head.appendChild(style);
      }

      markerRef.current = new maplibregl.Marker({ element: wrapper, anchor: "center" })
        .setLngLat(userLocation)
        .addTo(mapRef.current);
    });

    return () => {
      destroyed = true;
    };
  }, [userLocation, mapReady, mapRef]);

  return null;
}
