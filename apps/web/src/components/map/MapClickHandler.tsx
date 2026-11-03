"use client";

import { useCrowdReportStore } from "@integrations/crowd-reports/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import {
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  useNavigationStore,
  useParkingStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { claimMapClick, getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { bindMapMarkerActivation } from "@/integration-api/map/mapMarkerActivation";
import { closePlaceSelection } from "@/lib/closeSurfaces";
import { haptics } from "@/lib/haptics";
import { initializeMapClickModes } from "@/lib/mapClickModes";
import { bindMapLongPress, cameFromTouch, consumeLongPressClick } from "@/lib/mapTouch";

// Configure before any map listener mounts. Read live mode state at the first
// callback for each click; capture may clear that state before later callbacks.
initializeMapClickModes();

/** Drops the gray pin, replacing whatever place was open. */
function dropPinAt(coordinates: [number, number]): void {
  usePlaceStore.getState().setSelectedPlace(null);
  if (useSidebarStore.getState().activeSidebarId === PANEL.PLACE) {
    useSidebarStore.getState().closeSidebar();
  }
  useSidebarStore.getState().closeDetail();
  useMapClickStore.getState().setClickedLngLat(coordinates);
}

/**
 * A tap on empty map on a touch screen only puts away what is open — the
 * dropped pin's card, then the place — as in native map apps, where people tap
 * the map to clear it and long-press to drop a pin.
 */
function dismissOnTap(): void {
  if (useMapClickStore.getState().clickedLngLat) {
    useMapClickStore.getState().setClickedLngLat(null);
    return;
  }
  if (usePlaceStore.getState().selectedPlace) closePlaceSelection();
}

export function MapClickHandler() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { selectedPlace } = usePlaceStore();
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Register plain-map click handler
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      // The click some browsers fire as a long-press lifts: the pin is down.
      if (consumeLongPressClick()) return;
      const owner = getMapClickOwner(e);
      // Repositioning a parked pin consumes the tap: falling through would also
      // deselect the place and drop a grey pin under the one being moved.
      if (owner === "parking") {
        if (claimMapClick(e, owner))
          useParkingStore.getState().setPickedCoords([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // Crowd-report location picking: consume the tap to place the report point
      // and re-open the dialog, instead of the normal place/waypoint behavior.
      if (owner === "crowd") {
        if (claimMapClick(e, owner))
          useCrowdReportStore.getState().setLocation([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (owner) return;
      if (useTravelTimeStore.getState().isActive) return;
      // A dropped pin and its place panel only get in the way while navigating.
      if (useNavigationStore.getState().status !== "idle") return;

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

      if (cameFromTouch(e.originalEvent)) {
        dismissOnTap();
        return;
      }
      dropPinAt([e.lngLat.lng, e.lngLat.lat]);
    };

    // Touch screens drop the pin on a long-press instead. Pickers and tools
    // own the map's taps while active, and guidance has no use for a pin.
    const unbindLongPress = bindMapLongPress(map, (coordinates, event) => {
      if (getMapClickOwner(event)) return;
      if (useNavigationStore.getState().status !== "idle") return;
      haptics.tap();
      dropPinAt(coordinates);
    });

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      unbindLongPress();
    };
  }, [mapRef, mapReady, styleVersion]);

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
        // Tapping the dropped pin would otherwise re-drop it at the tapped spot,
        // a pin's height above where it stood.
        bindMapMarkerActivation(el);
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
