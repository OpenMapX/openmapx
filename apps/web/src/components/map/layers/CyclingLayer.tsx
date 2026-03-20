"use client";

import {
  useCyclingStore,
  useDirectionsStore,
  useLayerStore,
  useOverlayExclusion,
} from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import {
  CYCLING_COLORS,
  CYCLING_LAYER_IDS,
  CYCLING_MIN_ZOOM,
  CYCLING_POI_SOURCE_LAYER,
  CYCLING_SOURCE_LAYER,
} from "./cyclingConfig";
import {
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "./layerStyleUtils";

function findTransportationSource(map: maplibregl.Map): string | null {
  const layers = map.getStyle().layers;
  if (!layers) return null;

  for (const layer of layers) {
    if (!("source" in layer) || !("source-layer" in layer)) continue;
    const sourceLayer = (layer as Record<string, unknown>)["source-layer"];
    if (sourceLayer === "transportation" && typeof layer.source === "string") {
      return layer.source;
    }
  }

  return null;
}

function findPoiSource(map: maplibregl.Map): string | null {
  const layers = map.getStyle().layers;
  if (!layers) return null;

  for (const layer of layers) {
    if (!("source" in layer) || !("source-layer" in layer)) continue;
    const sourceLayer = (layer as Record<string, unknown>)["source-layer"];
    if (sourceLayer === "poi" && typeof layer.source === "string") {
      return layer.source;
    }
  }

  return null;
}

export function CyclingLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useCyclingStore((s) => s.layerVisible);
  useOverlayExclusion("cycling", layerVisible);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const directionsMode = useDirectionsStore((s) => s.mode);
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const prevModeRef = useRef(directionsMode);

  // Auto-enable cycling overlay when user enters cycling directions mode
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = directionsMode;

    if (!directionsOpen) {
      const store = useCyclingStore.getState();
      if (store.autoEnabled && store.panelOpen) {
        store.closePanel();
      }
      return;
    }

    if (directionsMode === "cycling" && prev !== "cycling") {
      const store = useCyclingStore.getState();
      if (!store.panelOpen) {
        store.openPanel();
        store.setAutoEnabled(true);
      }
    } else if (directionsMode !== "cycling" && prev === "cycling") {
      const store = useCyclingStore.getState();
      if (store.autoEnabled) {
        store.closePanel();
      }
    }
  }, [directionsMode, directionsOpen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!map.isStyleLoaded()) return;

      const transportSource = findTransportationSource(map);
      const poiSource = findPoiSource(map);

      if (layerVisible && transportSource) {
        // Dedicated cycleways (tracks)
        if (!map.getLayer(CYCLING_LAYER_IDS.tracks)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.tracks,
              type: "line",
              source: transportSource,
              "source-layer": CYCLING_SOURCE_LAYER,
              minzoom: CYCLING_MIN_ZOOM,
              filter: [
                "all",
                ["==", ["get", "class"], "path"],
                ["==", ["get", "subclass"], "cycleway"],
              ],
              paint: {
                "line-color": CYCLING_COLORS.track,
                "line-opacity": 0.85,
                "line-width": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  CYCLING_MIN_ZOOM,
                  1.5,
                  14,
                  3,
                  18,
                  5,
                ],
              },
              layout: {
                "line-cap": "round",
                "line-join": "round",
              },
            },
            beforeId,
          );
        }

        // Roads with bike lanes (bicycle=designated)
        if (!map.getLayer(CYCLING_LAYER_IDS.lanes)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.lanes,
              type: "line",
              source: transportSource,
              "source-layer": CYCLING_SOURCE_LAYER,
              minzoom: 12,
              filter: [
                "all",
                [
                  "in",
                  ["get", "class"],
                  ["literal", ["primary", "secondary", "tertiary", "minor", "service"]],
                ],
                ["==", ["get", "bicycle"], "designated"],
              ],
              paint: {
                "line-color": CYCLING_COLORS.lane,
                "line-opacity": 0.8,
                "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 14, 3, 18, 4],
                "line-dasharray": [2, 1],
              },
              layout: {
                "line-cap": "butt",
                "line-join": "round",
              },
            },
            beforeId,
          );
        }

        // Bicycle-designated roads
        if (!map.getLayer(CYCLING_LAYER_IDS.designated)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.designated,
              type: "line",
              source: transportSource,
              "source-layer": CYCLING_SOURCE_LAYER,
              minzoom: 14,
              filter: [
                "all",
                [
                  "in",
                  ["get", "class"],
                  ["literal", ["primary", "secondary", "tertiary", "minor", "service", "track"]],
                ],
                ["==", ["get", "bicycle"], "yes"],
              ],
              paint: {
                "line-color": CYCLING_COLORS.designated,
                "line-opacity": 0.7,
                "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 3],
              },
              layout: {
                "line-cap": "round",
                "line-join": "round",
              },
            },
            beforeId,
          );
        }

        // Bicycle-permitted paths
        if (!map.getLayer(CYCLING_LAYER_IDS.permitted)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.permitted,
              type: "line",
              source: transportSource,
              "source-layer": CYCLING_SOURCE_LAYER,
              minzoom: 14,
              filter: [
                "all",
                ["==", ["get", "class"], "path"],
                ["!=", ["get", "subclass"], "cycleway"],
                ["==", ["get", "bicycle"], "yes"],
              ],
              paint: {
                "line-color": CYCLING_COLORS.permitted,
                "line-opacity": 0.7,
                "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 3],
                "line-dasharray": [3, 1.5, 1, 1.5],
              },
              layout: {
                "line-cap": "butt",
                "line-join": "round",
              },
            },
            beforeId,
          );
        }
      }

      if (layerVisible && poiSource) {
        // Bike parking
        if (!map.getLayer(CYCLING_LAYER_IDS.parking)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.parking,
              type: "circle",
              source: poiSource,
              "source-layer": CYCLING_POI_SOURCE_LAYER,
              minzoom: 14,
              filter: ["==", ["get", "subclass"], "bicycle_parking"],
              paint: {
                "circle-color": CYCLING_COLORS.parking,
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 6],
                "circle-opacity": 0.85,
                "circle-stroke-width": 1.5,
                "circle-stroke-color": "#ffffff",
              },
            },
            beforeId,
          );
        }

        // Bike shops + repair stations + rental
        if (!map.getLayer(CYCLING_LAYER_IDS.shops)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.shops,
              type: "circle",
              source: poiSource,
              "source-layer": CYCLING_POI_SOURCE_LAYER,
              minzoom: 16,
              filter: [
                "in",
                ["get", "subclass"],
                ["literal", ["bicycle", "bicycle_rental", "bicycle_repair_station"]],
              ],
              paint: {
                "circle-color": [
                  "match",
                  ["get", "subclass"],
                  "bicycle",
                  CYCLING_COLORS.shop,
                  "bicycle_repair_station",
                  CYCLING_COLORS.repair,
                  "bicycle_rental",
                  CYCLING_COLORS.rental,
                  CYCLING_COLORS.shop,
                ],
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 4, 18, 7],
                "circle-opacity": 0.9,
                "circle-stroke-width": 1.5,
                "circle-stroke-color": "#ffffff",
              },
            },
            beforeId,
          );
        }

        // POI labels
        if (!map.getLayer(CYCLING_LAYER_IDS.labels)) {
          const beforeId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: CYCLING_LAYER_IDS.labels,
              type: "symbol",
              source: poiSource,
              "source-layer": CYCLING_POI_SOURCE_LAYER,
              minzoom: 16,
              filter: [
                "in",
                ["get", "subclass"],
                [
                  "literal",
                  ["bicycle_parking", "bicycle", "bicycle_rental", "bicycle_repair_station"],
                ],
              ],
              layout: {
                "text-field": ["get", "name"],
                "text-size": 11,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-optional": true,
                "text-max-width": 8,
              },
              paint: {
                "text-color": "#333333",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.5,
              },
            },
            beforeId,
          );
        }
      }

      // Move all layers before first symbol so they stay below labels
      if (layerVisible) {
        for (const layerId of Object.values(CYCLING_LAYER_IDS)) {
          moveLayerBeforeFirstSymbol(map, layerId);
        }
        // Labels layer should be above other cycling layers, but it's a symbol
        // so it naturally stays in the right position
      }

      // Toggle visibility
      for (const layerId of Object.values(CYCLING_LAYER_IDS)) {
        setLayerVisibility(map, layerId, layerVisible);
      }
    };

    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, mapRef, layerVisible]);

  // Re-anchor after base map changes (activeLayer triggers re-ordering)
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeLayer triggers layer re-ordering on base map switch
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    for (const layerId of Object.values(CYCLING_LAYER_IDS)) {
      if (layerId === CYCLING_LAYER_IDS.labels) continue;
      moveLayerBeforeFirstSymbol(map, layerId);
    }
  }, [activeLayer, mapReady, mapRef, layerVisible]);

  // Cursor interactivity for POI layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const poiLayers = [CYCLING_LAYER_IDS.parking, CYCLING_LAYER_IDS.shops];

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const activeLayers = poiLayers.filter((id) => !!map.getLayer(id));
      if (activeLayers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    map.on("mousemove", onMouseMove);

    return () => {
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapReady, mapRef, layerVisible]);

  return null;
}
