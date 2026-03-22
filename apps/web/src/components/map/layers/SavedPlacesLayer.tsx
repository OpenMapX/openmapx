"use client";

import { PANEL, useSavedListPlaces, useSavedPlacesStore, useSidebarStore } from "@openmapx/core";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "saved-places-source";
const LAYER_ID = "saved-places-layer";

export function SavedPlacesLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const isPanelOpen = useSidebarStore((s) => s.activeSidebarId === PANEL.SAVED);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const { data: places } = useSavedListPlaces(
    isPanelOpen && selectedListId ? selectedListId : null,
  );

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !places || places.length === 0) return;

    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: places.map((p) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [p.lng, p.lat],
        },
        properties: { id: p.id, name: p.name },
      })),
    };

    const existing = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(geojson);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
      map.addLayer({
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        paint: {
          "circle-radius": 8,
          "circle-color": "#E53935",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });
    }

    return () => {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Source may already be torn down during style change
      }
    };
  }, [mapRef, mapReady, styleVersion, places]);

  // Clean up when panel closes or list deselected
  useEffect(() => {
    if (isPanelOpen && selectedListId) return;
    const map = mapRef.current;
    if (!map) return;
    try {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch {
      // Ignore cleanup errors
    }
  }, [mapRef, isPanelOpen, selectedListId]);

  return null;
}
