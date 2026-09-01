"use client";

import { PANEL, useSavedListPlaces, useSavedPlacesStore, useSidebarStore } from "@openmapx/core";
import { useEffect } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { removeLayerAndSource, upsertGeoJsonSource } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";

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

    const created = !map.getSource(SOURCE_ID);
    upsertGeoJsonSource(map, SOURCE_ID, geojson);
    if (created) {
      addLayerInSlot(
        map,
        {
          id: LAYER_ID,
          type: "circle",
          source: SOURCE_ID,
          paint: {
            "circle-radius": 8,
            "circle-color": "#E53935",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        },
        "route-markers",
        5,
      );
    }

    return () => {
      removeLayerAndSource(map, LAYER_ID, SOURCE_ID);
      unregisterLayerSlot(LAYER_ID);
    };
  }, [mapRef, mapReady, styleVersion, places]);

  // Clean up when panel closes or list deselected
  useEffect(() => {
    if (isPanelOpen && selectedListId) return;
    const map = mapRef.current;
    if (!map) return;
    removeLayerAndSource(map, LAYER_ID, SOURCE_ID);
    unregisterLayerSlot(LAYER_ID);
  }, [mapRef, isPanelOpen, selectedListId]);

  return null;
}
