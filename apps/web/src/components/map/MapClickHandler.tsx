"use client";

import { useCrowdReportStore } from "@integrations/crowd-reports/store";
import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import {
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  useParkingStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";

export function MapClickHandler() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { selectedPlace, setSelectedPlace } = usePlaceStore();
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Register plain-map click handler
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      // Repositioning a parked pin consumes the tap: falling through would also
      // deselect the place and drop a grey pin under the one being moved.
      if (useParkingStore.getState().picking) {
        useParkingStore.getState().setPickedCoords([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // Crowd-report location picking: consume the tap to place the report point
      // and re-open the dialog, instead of the normal place/waypoint behavior.
      if (useCrowdReportStore.getState().picking) {
        useCrowdReportStore.getState().setLocation([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (useMeasurementStore.getState().isActive) return;
      if (useTravelTimeStore.getState().isActive) return;

      const activeLayers = [...INTERACTIVE_LAYER_IDS].filter((id) => !!map.getLayer(id));
      if (activeLayers.length > 0) {
        const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
        if (features.length > 0) return;
      }

      // When directions panel is open, fill the next empty waypoint
      const dirStore = useDirectionsStore.getState();
      if (dirStore.isOpen) {
        const emptyIdx = dirStore.waypoints.findIndex((wp) => wp.coords === null);
        if (emptyIdx !== -1) {
          const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          dirStore.setWaypoint(
            emptyIdx,
            coords,
            `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`,
          );
          return;
        }
      }

      setSelectedPlace(null);
      if (useSidebarStore.getState().activeSidebarId === PANEL.PLACE) {
        useSidebarStore.getState().closeSidebar();
      }
      useSidebarStore.getState().closeDetail();
      setClickedLngLat([e.lngLat.lng, e.lngLat.lat]);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, styleVersion, setClickedLngLat, setSelectedPlace]);

  // Clear clicked point when a place is selected externally (search, category click, etc.)
  useEffect(() => {
    if (selectedPlace) setClickedLngLat(null);
  }, [selectedPlace, setClickedLngLat]);

  // Gray pin marker that follows clickedLngLat
  useEffect(() => {
    const map = mapRef.current;
    if (!clickedLngLat || !map) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    if (markerRef.current) {
      markerRef.current.setLngLat(clickedLngLat);
      return;
    }

    let destroyed = false;
    void import("maplibre-gl")
      .then((ml) => {
        if (destroyed || !mapRef.current) return;
        const el = document.createElement("div");
        el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="32" viewBox="0 0 27 43">
        <path d="M13.5 0C6.044 0 0 6.044 0 13.5c0 9.219 13.5 29.5 13.5 29.5S27 22.719 27 13.5C27 6.044 20.956 0 13.5 0z" fill="#757575" stroke="#424242" stroke-width="1"/>
        <circle cx="13.5" cy="13.5" r="5.5" fill="white"/>
      </svg>`;
        markerRef.current = new ml.Marker({ element: el, anchor: "bottom" })
          .setLngLat(clickedLngLat)
          .addTo(mapRef.current);
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [clickedLngLat, mapRef]);

  // Remove marker on unmount
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  return null;
}
