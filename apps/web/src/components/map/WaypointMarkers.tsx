"use client";

import type { LngLat } from "@openmapx/core";
import { useDirectionsStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { bindMapMarkerActivation } from "@/integration-api/map/mapMarkerActivation";
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

interface WaypointMarkerEntry {
  marker: maplibregl.Marker;
  /** Position-dependent look the element was built for. */
  role: string;
  dragging: boolean;
}

function markerRole(index: number, count: number): string {
  if (index === 0) return "origin";
  if (index === count - 1) return "destination";
  return `stop:${index}`;
}

export function WaypointMarkers() {
  const { mapRef, mapReady } = useMap();
  const { isOpen, waypoints } = useDirectionsStore();
  const markersRef = useRef<Map<string, WaypointMarkerEntry>>(new Map());

  useEffect(() => {
    if (!isOpen) {
      for (const entry of markersRef.current.values()) {
        entry.marker.remove();
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

          const role = markerRole(i, waypoints.length);
          const existing = markersRef.current.get(wp.id);
          if (existing) {
            // Never rebuild or move a marker the user is dragging; the store update
            // its dragend makes runs this effect again.
            if (existing.dragging) return;
            if (existing.role === role) {
              existing.marker.setLngLat(wp.coords);
              return;
            }
            existing.marker.remove();
            markersRef.current.delete(wp.id);
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

          // A waypoint is moved by dragging; a plain tap on it must not fill the
          // next empty waypoint or drop a pin at the spot it covers.
          bindMapMarkerActivation(el);
          const marker = new maplibregl.Marker({ element: el, anchor, draggable: true })
            .setLngLat(wp.coords)
            .addTo(map);

          const entry: WaypointMarkerEntry = { marker, role, dragging: false };
          const id = wp.id;
          marker.on("dragstart", () => {
            entry.dragging = true;
          });
          marker.on("dragend", () => {
            entry.dragging = false;
            const lngLat = marker.getLngLat();
            const coords: LngLat = [lngLat.lng, lngLat.lat];
            // Waypoints keep their id when reversed, inserted around, removed or
            // reordered, so look up where this one is now.
            const { waypoints: current, setWaypoint } = useDirectionsStore.getState();
            const index = current.findIndex((candidate) => candidate.id === id);
            const waypoint = current[index];
            if (!waypoint) return;
            setWaypoint(index, coords, waypoint.label);
          });

          markersRef.current.set(id, entry);
        });

        // Remove markers for waypoints that no longer exist
        for (const [id, entry] of markersRef.current) {
          if (!currentIds.has(id)) {
            entry.marker.remove();
            markersRef.current.delete(id);
          }
        }
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [isOpen, waypoints, mapRef, mapReady]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const entry of markersRef.current.values()) {
        entry.marker.remove();
      }
      markersRef.current.clear();
    };
  }, []);

  return null;
}
