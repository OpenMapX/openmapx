"use client";

import { PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import type { MapMouseEvent, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";

// OpenMapTiles source-layer names that contain named POIs
const POI_SOURCE_LAYERS = new Set(["poi"]);

// Our own overlay layers — never treat these as style POIs
const OWN_LAYER_IDS = new Set([
  "category-results-layer",
  "category-results-labels",
  "mapillary-sequence-layer",
  "mapillary-photo-layer",
  "mapillary-pano-layer",
]);

type StyleLayer = StyleSpecification["layers"][number];

function getPoiLayerIds(map: import("maplibre-gl").Map): string[] {
  const style = map.getStyle();
  if (!style?.layers) return [];
  return (style.layers as StyleLayer[])
    .filter((layer) => {
      if (layer.type !== "symbol") return false;
      if (OWN_LAYER_IDS.has(layer.id)) return false;
      const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
      return !!sourceLayer && POI_SOURCE_LAYERS.has(sourceLayer);
    })
    .map((l) => l.id);
}

/**
 * Makes the map style's built-in POI symbols (restaurants, hotels, hospitals,
 * parks, etc.) clickable. Clicking a named POI opens the place details panel
 * via the same flow as search results — name + coordinate lookup against
 * Nominatim, followed by knowledge lookup.
 */
export function MapStylePoiClickHandler() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { setSelectedPlace } = usePlaceStore();
  const poiLayerIdsRef = useRef<string[]>([]);

  // Discover POI layers from the style and keep the shared interactive-layer
  // registry in sync so MapClickHandler doesn't clear the selection on click.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let registeredIds: string[] = [];

    const syncLayers = () => {
      // getStyle() returns null/undefined while style is still loading
      const ids = getPoiLayerIds(map);
      if (ids.length === 0 && registeredIds.length === 0) return;

      for (const id of registeredIds) {
        if (!ids.includes(id)) INTERACTIVE_LAYER_IDS.delete(id);
      }
      for (const id of ids) INTERACTIVE_LAYER_IDS.add(id);

      registeredIds = ids;
      poiLayerIdsRef.current = ids;
    };

    // "load" fires when the style is fully ready; "styledata" covers subsequent
    // layer changes (e.g. satellite toggle). We try immediately as well in case
    // the style was already loaded before this effect ran.
    syncLayers();
    map.on("load", syncLayers);
    map.on("styledata", syncLayers);

    return () => {
      map.off("load", syncLayers);
      map.off("styledata", syncLayers);
      for (const id of registeredIds) INTERACTIVE_LAYER_IDS.delete(id);
      poiLayerIdsRef.current = [];
    };
  }, [mapRef, mapReady, styleVersion]);

  // Click handler: open the place details panel for the topmost named POI.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      const layerIds = poiLayerIdsRef.current.filter((id) => !!map.getLayer(id));
      if (layerIds.length === 0) return;

      // Skip if the click landed on one of our own overlay layers (category results,
      // data source markers, street view, etc.) — those have their own handlers.
      const ownLayers = [...INTERACTIVE_LAYER_IDS].filter(
        (id) => !layerIds.includes(id) && !!map.getLayer(id),
      );
      if (
        ownLayers.length > 0 &&
        map.queryRenderedFeatures(e.point, { layers: ownLayers }).length > 0
      ) {
        return;
      }

      const features = map.queryRenderedFeatures(e.point, { layers: layerIds });
      if (!features.length) return;

      const feature = features[0];
      if (feature.geometry.type !== "Point") return;

      const name: string | undefined = feature.properties?.name;
      if (!name) return;

      const coords = feature.geometry.coordinates as [number, number];

      // Build a deterministic, non-OSM ID so the API uses name + coordinate
      // lookup (which finds the correct OSM element for knowledge data).
      const featureId = feature.id ?? `${coords[0].toFixed(5)}-${coords[1].toFixed(5)}`;
      const id = `style-poi-${featureId}`;

      const poiClass = feature.properties?.class as string | undefined;
      const poiSubclass = feature.properties?.subclass as string | undefined;

      setSelectedPlace({
        id,
        name,
        address: name,
        coordinates: coords,
        // Use subclass as category (more specific, e.g. "charging_station")
        // and fall back to class (broader, e.g. "car")
        category: poiSubclass ?? poiClass,
        rawCategory: poiSubclass ? `${poiClass}/${poiSubclass}` : poiClass,
      });
      const sidebarId = useSidebarStore.getState().activeSidebarId;
      if (!sidebarId || sidebarId === PANEL.PLACE) {
        // Sidebar is empty or already showing a place — take it over and close any
        // floating card so we don't show the same place in two panels at once.
        useSidebarStore.getState().closeDetail();
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      } else {
        // Another panel (category results, data source, directions …) is active —
        // keep it and show just the floating detail card.
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      }
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, styleVersion, setSelectedPlace]);

  // Cursor: show pointer when hovering over any named style POI.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onMouseMove = (e: MapMouseEvent) => {
      const layerIds = poiLayerIdsRef.current.filter((id) => !!map.getLayer(id));
      if (layerIds.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: layerIds });
      if (features.some((f) => f.properties?.name)) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    const onMouseLeave = () => {
      map.getCanvasContainer().style.cursor = "";
    };

    map.on("mousemove", onMouseMove);
    map.on("mouseleave", onMouseLeave);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseleave", onMouseLeave);
    };
  }, [mapRef, mapReady, styleVersion]);

  return null;
}
