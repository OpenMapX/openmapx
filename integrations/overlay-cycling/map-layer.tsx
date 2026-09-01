"use client";

import { runOverlayTransaction, useDirectionsStore, useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import {
  CYCLING_COLORS,
  CYCLING_LAYER_IDS,
  CYCLING_MIN_ZOOM,
  CYCLING_POI_SOURCE_LAYER,
  CYCLING_SOURCE_LAYER,
} from "@/integration-api/map/cyclingConfig";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { setLayerVisibility } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { useCyclingStore } from "./store";

function findTransportationSource(map: maplibregl.Map): string | null {
  const layers = map.getStyle()?.layers;
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

const CYCLING_AUTOMATION_ORIGIN = { kind: "automation", owner: "cycling" } as const;

function findPoiSource(map: maplibregl.Map): string | null {
  const layers = map.getStyle()?.layers;
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
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useCyclingStore((s) => s.layerVisible);
  useOverlayExclusion("cycling", layerVisible);
  const directionsMode = useDirectionsStore((s) => s.mode);
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const prevModeRef = useRef(directionsMode);

  // Auto-enable cycling overlay when user enters cycling directions mode. This
  // runs its writes through runOverlayTransaction, tagged as its own
  // contextual-automation owner, so a userRevision bump never mistakes this
  // for a user toggle — the same reason ContextualOverlays does for the
  // overlays it drives.
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = directionsMode;

    if (!directionsOpen) {
      const store = useCyclingStore.getState();
      if (store.autoEnabled && store.panelOpen) {
        runOverlayTransaction("cycling", { panelOpen: false }, CYCLING_AUTOMATION_ORIGIN);
      }
      return;
    }

    if (directionsMode === "cycling" && prev !== "cycling") {
      const store = useCyclingStore.getState();
      if (!store.panelOpen) {
        runOverlayTransaction("cycling", { panelOpen: true }, CYCLING_AUTOMATION_ORIGIN);
        store.setAutoEnabled(true);
      }
    } else if (directionsMode !== "cycling" && prev === "cycling") {
      const store = useCyclingStore.getState();
      if (store.autoEnabled) {
        runOverlayTransaction("cycling", { panelOpen: false }, CYCLING_AUTOMATION_ORIGIN);
      }
    }
  }, [directionsMode, directionsOpen]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      const transportSource = findTransportationSource(map);
      const poiSource = findPoiSource(map);

      if (layerVisible && transportSource) {
        // Dedicated cycleways (tracks)
        if (!map.getLayer(CYCLING_LAYER_IDS.tracks)) {
          addLayerInSlot(
            map,
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
            "overlay-lines",
            0,
          );
        }

        // Roads with bike lanes (bicycle=designated)
        if (!map.getLayer(CYCLING_LAYER_IDS.lanes)) {
          addLayerInSlot(
            map,
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
            "overlay-lines",
            1,
          );
        }

        // Bicycle-designated roads
        if (!map.getLayer(CYCLING_LAYER_IDS.designated)) {
          addLayerInSlot(
            map,
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
            "overlay-lines",
            2,
          );
        }

        // Bicycle-permitted paths
        if (!map.getLayer(CYCLING_LAYER_IDS.permitted)) {
          addLayerInSlot(
            map,
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
            "overlay-lines",
            3,
          );
        }
      }

      if (layerVisible && poiSource) {
        // Bike parking
        if (!map.getLayer(CYCLING_LAYER_IDS.parking)) {
          addLayerInSlot(
            map,
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
            "overlay-points",
            9,
          );
        }

        // Bike shops + repair stations + rental
        if (!map.getLayer(CYCLING_LAYER_IDS.shops)) {
          addLayerInSlot(
            map,
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
            "overlay-points",
            10,
          );
        }

        // POI labels
        if (!map.getLayer(CYCLING_LAYER_IDS.labels)) {
          addLayerInSlot(
            map,
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
            "overlay-markers",
            2,
          );
        }
      }
    };

    syncLayers();
    map.on("styledata", syncLayers);

    for (const layerId of Object.values(CYCLING_LAYER_IDS)) {
      setLayerVisibility(map, layerId, layerVisible);
    }

    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  // Cursor interactivity for POI layers
  useEffect(() => {
    void styleVersion;
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
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  return null;
}
