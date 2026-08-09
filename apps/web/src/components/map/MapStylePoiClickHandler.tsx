"use client";

import { createPlace, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { findStylePoiAtPoint, getStylePoiLayerIds } from "./mapStylePoiTarget";

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
      const ids = getStylePoiLayerIds(map);
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
      const target = findStylePoiAtPoint(
        map,
        e.point,
        poiLayerIdsRef.current,
        INTERACTIVE_LAYER_IDS,
      );
      if (!target) return;

      setSelectedPlace(
        createPlace({
          primaryScheme: "stylePoi",
          ids: { stylePoi: target.featureId },
          name: target.name,
          address: target.name,
          coordinates: target.coordinates,
          category: target.category,
          rawCategory: target.rawCategory,
        }),
      );
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
    map.on("mouseout", onMouseLeave);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseLeave);
    };
  }, [mapRef, mapReady, styleVersion]);

  return null;
}
