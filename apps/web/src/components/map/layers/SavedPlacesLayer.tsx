"use client";

import {
  PANEL,
  type SavedPlace,
  useSavedListPlaces,
  useSavedPlacesStore,
  useSidebarStore,
} from "@openmapx/core";
import { savedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import { withFeatureContributors } from "@openmapx/mobility-core/contributors";
import { useMemo } from "react";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

const SOURCE_ID = "saved-places-source";
const LAYER_ID = "saved-places-layer";

/** Project saved places once, noting whether any carries a coordinate receipt. */
function projectSavedPlaces(places: readonly SavedPlace[]) {
  let hasContributors = false;
  const features = places.map((place) => {
    const contributors = savedPlaceContributors(place.fieldContributors, ["lat", "lng"]);
    hasContributors ||= contributors.length > 0;
    return withFeatureContributors(
      {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [place.lng, place.lat] },
        properties: { id: place.id, name: place.name },
      },
      contributors,
    );
  });
  return { hasContributors, data: { type: "FeatureCollection" as const, features } };
}

function savedPlacesGroup(data: GeoJSON.FeatureCollection): MapLayerGroup {
  return {
    sources: { [SOURCE_ID]: { type: "geojson", data } },
    layers: [
      {
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        slot: "route-markers",
        order: 5,
        paint: {
          "circle-radius": 8,
          "circle-color": "#E53935",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      },
    ],
  };
}

export function SavedPlacesLayer() {
  const isPanelOpen = useSidebarStore((s) => s.activeSidebarId === PANEL.SAVED);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const activeListId = isPanelOpen && selectedListId ? selectedListId : null;
  const { data: places } = useSavedListPlaces(activeListId);
  const shown = activeListId !== null && places !== undefined && places.length > 0;

  const projected = useMemo(() => (shown ? projectSavedPlaces(places) : null), [shown, places]);
  useRenderedMapAttributions("saved-places", [LAYER_ID], Boolean(projected?.hasContributors));
  useMapLayerGroup(useMemo(() => projected && savedPlacesGroup(projected.data), [projected]));

  return null;
}
