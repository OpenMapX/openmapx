"use client";

import type { LngLat } from "@openmapx/core";
import { useDirectionsStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";

const PIN_SVG_NS = "http://www.w3.org/2000/svg";

function createOriginElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "cursor:grab;";
  const dot = document.createElement("div");
  dot.style.cssText =
    "width:16px;height:16px;border-radius:50%;border:3px solid #555;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);";
  el.appendChild(dot);
  return el;
}

function createWaypointElement(number: number): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "cursor:grab;";
  const badge = document.createElement("div");
  badge.style.cssText = `width:24px;height:24px;border-radius:4px;background:${BRAND};color:#fff;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.3);line-height:1;`;
  badge.textContent = String(number);
  el.appendChild(badge);
  return el;
}

function createDestinationElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "cursor:grab;";

  const svg = document.createElementNS(PIN_SVG_NS, "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "32");
  svg.setAttribute("viewBox", "0 0 27 43");

  const path = document.createElementNS(PIN_SVG_NS, "path");
  path.setAttribute(
    "d",
    "M13.5 0C6.044 0 0 6.044 0 13.5c0 9.219 13.5 29.5 13.5 29.5S27 22.719 27 13.5C27 6.044 20.956 0 13.5 0z",
  );
  path.setAttribute("fill", "#EA4335");
  path.setAttribute("stroke", "#C5221F");
  path.setAttribute("stroke-width", "1");
  svg.appendChild(path);

  const circle = document.createElementNS(PIN_SVG_NS, "circle");
  circle.setAttribute("cx", "13.5");
  circle.setAttribute("cy", "13.5");
  circle.setAttribute("r", "5.5");
  circle.setAttribute("fill", "white");
  svg.appendChild(circle);

  el.appendChild(svg);
  return el;
}

export function WaypointMarkers() {
  const { mapRef, mapReady } = useMap();
  const { isOpen, waypoints, setWaypoint } = useDirectionsStore();
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());

  useEffect(() => {
    if (!isOpen) {
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
      return;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !mapReady) return;

    let destroyed = false;

    void import("maplibre-gl")
      .then((maplibregl) => {
        if (destroyed || !mapRef.current) return;

        const currentIds = new Set<string>();

        waypoints.forEach((wp, i) => {
          if (!wp.coords) return;
          currentIds.add(wp.id);

          const existing = markersRef.current.get(wp.id);
          if (existing) {
            existing.setLngLat(wp.coords);
            return;
          }

          const isOrigin = i === 0;
          const isDestination = i === waypoints.length - 1;

          let el: HTMLDivElement;
          let anchor: maplibregl.MarkerOptions["anchor"] = "center";

          if (isOrigin) {
            el = createOriginElement();
          } else if (isDestination) {
            el = createDestinationElement();
            anchor = "bottom";
          } else {
            el = createWaypointElement(i);
          }

          const map = mapRef.current;
          if (!map) return;

          const marker = new maplibregl.Marker({ element: el, anchor, draggable: true })
            .setLngLat(wp.coords)
            .addTo(map);

          marker.on("dragend", () => {
            const lngLat = marker.getLngLat();
            const coords: LngLat = [lngLat.lng, lngLat.lat];
            setWaypoint(i, coords, wp.label);
          });

          markersRef.current.set(wp.id, marker);
        });

        // Remove markers for waypoints that no longer exist
        for (const [id, marker] of markersRef.current) {
          if (!currentIds.has(id)) {
            marker.remove();
            markersRef.current.delete(id);
          }
        }
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [isOpen, waypoints, mapRef, mapReady, setWaypoint]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
    };
  }, []);

  return null;
}
