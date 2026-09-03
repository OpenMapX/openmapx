"use client";

import type { CategoryPlace } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { Marker } from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";
import { getParkingCoords } from "./parkingCoords";

export interface ArrivalParkingMarkersProps {
  places: CategoryPlace[];
  selectedPlace: CategoryPlace | null;
  onSelectPlace: (place: CategoryPlace | null) => void;
  disabled?: boolean;
}

export function ArrivalParkingMarkers({
  places,
  selectedPlace,
  onSelectPlace,
  disabled = false,
}: ArrivalParkingMarkersProps) {
  const t = useTranslations("navigation");
  const mapCtx = useMapOptional();
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    const clearMarkers = () => {
      for (const marker of markersRef.current) {
        marker.remove();
      }
      markersRef.current = [];
    };

    const map: maplibregl.Map | null = mapCtx?.mapRef.current ?? null;
    if (!map) {
      clearMarkers();
      return;
    }

    clearMarkers();

    places.forEach((place) => {
      const coords = getParkingCoords(place);
      if (!coords) return;

      const isSelected = selectedPlace?.id === place.id;
      const el = document.createElement("div");
      el.className = "omx-arrival-parking-marker";
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", place.name || t("nearbyParking"));
      el.setAttribute("aria-pressed", isSelected ? "true" : "false");
      el.setAttribute("aria-disabled", disabled ? "true" : "false");
      el.tabIndex = disabled ? -1 : 0;
      el.style.width = "28px";
      el.style.height = "28px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = isSelected ? PRIMARY_BLUE_HEX : "#ffffff";
      el.style.color = isSelected ? "#ffffff" : PRIMARY_BLUE_HEX;
      el.style.border = `2px solid ${PRIMARY_BLUE_HEX}`;
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.fontWeight = "bold";
      el.style.fontSize = "14px";
      el.style.cursor = disabled ? "default" : "pointer";
      el.style.boxShadow = "0 2px 4px rgba(0,0,0,0.2)";
      el.textContent = "P";

      el.addEventListener("click", () => {
        if (!disabled) onSelectPlace(isSelected ? null : place);
      });

      el.addEventListener("keydown", (e) => {
        if (!disabled && (e.key === "Enter" || e.key === " " || e.key === "Spacebar")) {
          e.preventDefault();
          onSelectPlace(isSelected ? null : place);
        }
      });

      const marker = new Marker({ element: el }).setLngLat(coords).addTo(map);

      markersRef.current.push(marker);
    });

    return () => {
      clearMarkers();
    };
  }, [disabled, mapCtx, places, selectedPlace, onSelectPlace, t]);

  return null;
}
