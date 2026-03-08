"use client";

import { usePlaceStore } from "@openmapx/core";
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
 * Nominatim, followed by enrichment.
 */
export function MapStylePoiClickHandler() {
  const { mapRef, mapReady } = useMap();
  const { setSelectedPlace } = usePlaceStore();
  const poiLayerIdsRef = useRef<string[]>([]);

  // Discover POI layers from the style and keep the shared interactive-layer
  // registry in sync so MapClickHandler doesn't clear the selection on click.
  useEffect(() => {
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
  }, [mapRef, mapReady]);

  // Click handler: open the place details panel for the topmost named POI.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      const layerIds = poiLayerIdsRef.current.filter((id) => !!map.getLayer(id));
      if (layerIds.length === 0) return;

      const features = map.queryRenderedFeatures(e.point, { layers: layerIds });
      if (!features.length) return;

      const feature = features[0];
      if (feature.geometry.type !== "Point") return;

      const name: string | undefined = feature.properties?.name;
      if (!name) return;

      const coords = feature.geometry.coordinates as [number, number];

      // Build a deterministic, non-OSM ID so the API uses name + coordinate
      // lookup (which finds the correct OSM element for enrichment).
      const featureId = feature.id ?? `${coords[0].toFixed(5)}-${coords[1].toFixed(5)}`;
      const id = `style-poi-${featureId}`;

      setSelectedPlace({
        id,
        name,
        address: name,
        coordinates: coords,
        category: feature.properties?.class ?? feature.properties?.subclass,
      });
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, setSelectedPlace]);

  // Cursor: show pointer when hovering over any named style POI.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onMouseMove = (e: MapMouseEvent) => {
      const layerIds = poiLayerIdsRef.current.filter((id) => !!map.getLayer(id));
      if (layerIds.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: layerIds });
      map.getCanvas().style.cursor = features.some((f) => f.properties?.name) ? "pointer" : "";
    };

    const onMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("mousemove", onMouseMove);
    map.on("mouseleave", onMouseLeave);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseleave", onMouseLeave);
    };
  }, [mapRef, mapReady]);

  return null;
}
