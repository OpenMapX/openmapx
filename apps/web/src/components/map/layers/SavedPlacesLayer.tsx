"use client";

import { PANEL, useSavedListPlaces, useSavedPlacesStore, useSidebarStore } from "@openmapx/core";
import { savedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import { withFeatureContributors } from "@openmapx/mobility-core/contributors";
import { useEffect, useMemo } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { removeLayerAndSource, upsertGeoJsonSource } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

const SOURCE_ID = "saved-places-source";
const LAYER_ID = "saved-places-layer";

export function SavedPlacesLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const isPanelOpen = useSidebarStore((s) => s.activeSidebarId === PANEL.SAVED);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const { data: places } = useSavedListPlaces(
    isPanelOpen && selectedListId ? selectedListId : null,
  );

  const captured = useMemo(() => {
    let hasContributors = false;
    const features = (places ?? []).map((p) => {
      const contributors = savedPlaceContributors(p.fieldContributors, ["lat", "lng"]);
      hasContributors ||= contributors.length > 0;
      return withFeatureContributors(
        {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
          properties: { id: p.id, name: p.name },
        },
        contributors,
      );
    });
    return { hasContributors, data: { type: "FeatureCollection" as const, features } };
  }, [places]);
  useRenderedMapAttributions(
    "saved-places",
    [LAYER_ID],
    Boolean(isPanelOpen && selectedListId && captured.hasContributors),
  );

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || captured.data.features.length === 0) return;

    const created = !map.getSource(SOURCE_ID);
    upsertGeoJsonSource(map, SOURCE_ID, captured.data);
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
  }, [mapRef, mapReady, styleVersion, captured]);

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
