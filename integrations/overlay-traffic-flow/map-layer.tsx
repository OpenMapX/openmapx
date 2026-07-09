"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useStyleSyncedLayer } from "@/components/map/layers/useStyleSyncedLayer";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { useTrafficFlowStore } from "./store";

const SRC = "omx-traffic-flow-src";
const CASING = "omx-traffic-flow-casing";
const COLOR = "omx-traffic-flow-color";
const SOURCE_LAYER = "segment_flow";
const LAYER_MIN_ZOOM = 6;

/**
 * Relative-speed (`speed_ratio` = current ÷ free-flow) → TomTom-style color
 * bands. `speed_ratio` is coalesced to 1 (free-flow) so a base segment
 * with no `segment_speed` row yet still renders green rather than transparent.
 */
const COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "speed_ratio"], 1],
  0.0,
  "#7e0023",
  0.25,
  "#e8112d",
  0.5,
  "#ff8c00",
  0.75,
  "#ffd500",
  1.0,
  "#2ecc40",
];

/** Confidence → opacity: measured brightest, typical faintest. */
const OPACITY_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "confidence"],
  "measured",
  0.95,
  "estimated",
  0.7,
  "typical",
  0.4,
  0.4,
];

const COLOR_WIDTH_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["exponential", 1.4],
  ["zoom"],
  6,
  ["match", ["get", "highway"], "motorway", 1.5, 0.6],
  16,
  ["match", ["get", "highway"], "motorway", 7, 3],
];

const CASING_WIDTH_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["exponential", 1.4],
  ["zoom"],
  6,
  ["match", ["get", "highway"], "motorway", 3.5, 2],
  16,
  ["match", ["get", "highway"], "motorway", 11, 6],
];

/**
 * A CONSTANT positive offset for both directions. The `:b` (backward)
 * geometry is already `ST_Reverse`d into its own travel direction, so
 * "offset to the right of line direction" puts each carriageway on its own
 * side without matching on `dir`. A negative value for `dir === "b"` would
 * stack both directions on the SAME side instead.
 */
const OFFSET_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["exponential", 1.4],
  ["zoom"],
  6,
  0.5,
  16,
  3,
];

export function TrafficFlowLayer() {
  const map = useMap();
  const { mapRef, mapReady, styleVersion } = map;
  const env = useEnv();
  const showFlow = useTrafficFlowStore((s) => s.panelOpen && s.layerVisible);
  useIntegrationDomainAttribution("road-conditions", showFlow);
  useOverlayExclusion("traffic-flow", showFlow);
  useLayerReanchor([CASING, COLOR], showFlow);

  const martinBase = env.martinBaseUrl;

  const addSource = (m: maplibregl.Map) => {
    m.addSource(SRC, {
      type: "vector",
      // Bare function name — Martin's default function-source id (confirm via
      // /martin/catalog). No `.pbf` suffix: the PWA service worker
      // CacheFirst-caches /\.pbf$/ URLs for 30 days, which would freeze this
      // "live" layer.
      tiles: [`${martinBase}/segment_flow/{z}/{x}/{y}`],
      minzoom: 5,
      maxzoom: 16,
    });
  };

  useStyleSyncedLayer({
    map,
    visible: showFlow,
    sourceId: SRC,
    layerId: CASING,
    moveBeforeFirstSymbol: true,
    addSource,
    addLayer: (m, beforeLayerId) => {
      m.addLayer(
        {
          id: CASING,
          type: "line",
          source: SRC,
          "source-layer": SOURCE_LAYER,
          minzoom: LAYER_MIN_ZOOM,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#20242b",
            "line-width": CASING_WIDTH_EXPR,
            "line-gap-width": 0,
          },
        },
        beforeLayerId,
      );
    },
    deps: [mapReady, styleVersion, mapRef, showFlow, martinBase],
  });

  useStyleSyncedLayer({
    map,
    visible: showFlow,
    sourceId: SRC,
    layerId: COLOR,
    moveBeforeFirstSymbol: true,
    addSource,
    addLayer: (m, beforeLayerId) => {
      m.addLayer(
        {
          id: COLOR,
          type: "line",
          source: SRC,
          "source-layer": SOURCE_LAYER,
          minzoom: LAYER_MIN_ZOOM,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR_EXPR,
            "line-opacity": OPACITY_EXPR,
            "line-width": COLOR_WIDTH_EXPR,
            "line-offset": OFFSET_EXPR,
          },
        },
        beforeLayerId,
      );
    },
    deps: [mapReady, styleVersion, mapRef, showFlow, martinBase],
  });

  return null;
}
