"use client";

import {
  PANEL,
  useParkedLocations,
  useParkingStore,
  useSidebarStore,
  useVehicles,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";

const BADGE_FILL = "#1A73E8";

/**
 * Builds the marker DOM. A badge with a label rather than a styled layer: there
 * are at most a handful of these, they need a click target, and they must stay
 * legible over any basemap.
 */
function buildMarkerElement(label: string, onSelect: () => void): HTMLElement {
  const wrapper = document.createElement("button");
  wrapper.type = "button";
  wrapper.setAttribute("aria-label", label);
  wrapper.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:6px",
    "border:0",
    "padding:0",
    "background:none",
    "cursor:pointer",
    "font-family:'Plus Jakarta Sans Variable',Arial,sans-serif",
  ].join(";");

  const badge = document.createElement("span");
  badge.textContent = "P";
  badge.setAttribute("aria-hidden", "true");
  badge.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "width:24px",
    "height:24px",
    "border-radius:50%",
    `background:${BADGE_FILL}`,
    "border:2px solid white",
    "box-shadow:0 2px 6px rgba(0,0,0,0.35)",
    "color:white",
    "font-size:13px",
    "font-weight:700",
    "line-height:1",
  ].join(";");

  const caption = document.createElement("span");
  caption.textContent = label;
  caption.style.cssText = [
    "white-space:nowrap",
    "max-width:200px",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "font-size:13px",
    "font-weight:700",
    `color:${BADGE_FILL}`,
    "text-shadow:0 1px 2px rgba(255,255,255,0.9),0 0 4px rgba(255,255,255,0.7)",
  ].join(";");

  wrapper.append(badge, caption);
  wrapper.addEventListener("click", onSelect);
  return wrapper;
}

/**
 * The parked pins. Rendered whenever a record exists rather than while a panel
 * is open — finding the vehicle is the point, so the pin cannot be behind a
 * surface the user has to know to open first.
 */
export function ParkedVehicleMarkers() {
  const t = useTranslations("parking");
  const { mapRef, mapReady } = useMap();
  const { data: parked } = useParkedLocations();
  const { data: vehicles } = useVehicles();
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    const clearAll = () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
    };

    if (!mapReady || !parked || parked.length === 0) {
      clearAll();
      return;
    }

    let destroyed = false;

    void import("maplibre-gl")
      .then((maplibre) => {
        const map = mapRef.current;
        if (destroyed || !map) return;
        clearAll();
        for (const record of parked) {
          const vehicle = vehicles?.find((v) => v.id === record.vehicleId) ?? null;
          const element = buildMarkerElement(vehicle?.name ?? t("markerLabel"), () => {
            useParkingStore.getState().select(record.id);
            useSidebarStore.getState().closeDetail();
            useSidebarStore.getState().openSidebar(PANEL.PARKING);
          });
          markersRef.current.push(
            new maplibre.Marker({ element, anchor: "center" })
              .setLngLat([record.lng, record.lat])
              .addTo(map),
          );
        }
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
      clearAll();
    };
  }, [mapRef, mapReady, parked, vehicles, t]);

  return null;
}
