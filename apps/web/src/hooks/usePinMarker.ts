"use client";

import type { LngLat } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";

interface PinColor {
  fill: string;
  stroke: string;
}

const PIN_RED: PinColor = { fill: "#EA4335", stroke: "#C5221F" };

/**
 * Renders a teardrop pin marker on the map at `coords` (red by default).
 * Pass `null` to remove the marker. Reuses the same marker instance
 * when coords/label change to avoid flickering.
 */
export function usePinMarker(
  coords: LngLat | null,
  label: string,
  showLabel = true,
  color: PinColor = PIN_RED,
) {
  const { mapRef, mapReady } = useMap();
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);

  // Remove marker on unmount
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady is an intentional trigger so the marker is created once the map initializes
  useEffect(() => {
    if (!coords) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    let destroyed = false;

    void import("maplibre-gl")
      .then((maplibregl) => {
        if (destroyed || !mapRef.current) return;

        // Move and relabel existing marker instead of recreating
        if (markerRef.current) {
          markerRef.current.setLngLat(coords);
          if (labelRef.current) labelRef.current.textContent = label;
          return;
        }

        const el = document.createElement("div");
        el.style.cssText = "cursor:pointer;";

        const svgDiv = document.createElement("div");
        svgDiv.style.cssText = "transform-origin:bottom center;";
        svgDiv.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="32" viewBox="0 0 27 43">
          <path d="M13.5 0C6.044 0 0 6.044 0 13.5c0 9.219 13.5 29.5 13.5 29.5S27 22.719 27 13.5C27 6.044 20.956 0 13.5 0z"
                fill="${color.fill}" stroke="${color.stroke}" stroke-width="1"/>
          <circle cx="13.5" cy="13.5" r="5.5" fill="white"/>
        </svg>
      `;

        const labelContainer = document.createElement("div");
        labelContainer.style.cssText =
          "position:absolute;left:26px;top:0;bottom:0;display:flex;align-items:center;pointer-events:none;";

        const labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        labelSpan.style.cssText = [
          "white-space:nowrap",
          "max-width:200px",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "font-size:14px",
          "font-weight:700",
          "color:#B81C16",
          "text-shadow:0 1px 2px rgba(255,255,255,0.9),0 0 4px rgba(255,255,255,0.7)",
          "font-family:'Plus Jakarta Sans Variable',Arial,sans-serif",
        ].join(";");

        labelRef.current = labelSpan;
        labelContainer.appendChild(labelSpan);
        el.appendChild(svgDiv);
        if (showLabel) el.appendChild(labelContainer);

        markerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat(coords)
          .addTo(mapRef.current);
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [coords, label, mapRef, mapReady, showLabel, color]);
}
