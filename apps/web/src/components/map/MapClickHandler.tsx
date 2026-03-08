"use client";

import { useMapClickStore, usePlaceStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

// Layers with their own click handlers — plain-map click card should not fire when these are hit
const INTERACTIVE_LAYERS = [
  "category-results-layer",
  "mapillary-sequence-layer",
  "mapillary-photo-layer",
  "mapillary-pano-layer",
];

export function MapClickHandler() {
  const { mapRef, mapReady } = useMap();
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { selectedPlace, setSelectedPlace } = usePlaceStore();
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Register plain-map click handler
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      const activeLayers = INTERACTIVE_LAYERS.filter((id) => !!map.getLayer(id));
      if (activeLayers.length > 0) {
        const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
        if (features.length > 0) return;
      }
      setSelectedPlace(null);
      setClickedLngLat([e.lngLat.lng, e.lngLat.lat]);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, setClickedLngLat, setSelectedPlace]);

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
    import("maplibre-gl").then(({ default: ml }) => {
      if (destroyed || !mapRef.current) return;
      const el = document.createElement("div");
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="32" viewBox="0 0 27 43">
        <path d="M13.5 0C6.044 0 0 6.044 0 13.5c0 9.219 13.5 29.5 13.5 29.5S27 22.719 27 13.5C27 6.044 20.956 0 13.5 0z" fill="#757575" stroke="#424242" stroke-width="1"/>
        <circle cx="13.5" cy="13.5" r="5.5" fill="white"/>
      </svg>`;
      markerRef.current = new ml.Marker({ element: el, anchor: "bottom" })
        .setLngLat(clickedLngLat)
        .addTo(mapRef.current);
    });

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
