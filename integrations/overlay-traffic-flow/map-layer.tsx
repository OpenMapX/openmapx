"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useStyleSyncedLayer } from "@/components/map/layers/useStyleSyncedLayer";
import { buildPopupCard, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
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

/**
 * Confidence → opacity: measured brightest, typical faintest. The floor (0.6 for
 * `typical`/no-live-data segments) is kept high enough that covered roads still
 * read as faint colour rather than letting the casing show through as black —
 * most segments are `typical` where live flow data is sparse.
 */
const OPACITY_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "confidence"],
  "measured",
  0.95,
  "estimated",
  0.7,
  "typical",
  0.6,
  0.6,
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

// Only slightly wider than COLOR_WIDTH_EXPR so the casing reads as a thin outline
// (a fraction of a pixel to ~1px per side), not a slab that dominates the colour.
const CASING_WIDTH_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["exponential", 1.4],
  ["zoom"],
  6,
  ["match", ["get", "highway"], "motorway", 2.2, 1],
  16,
  ["match", ["get", "highway"], "motorway", 8.5, 4],
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

/**
 * Popup card layout for a clicked flow segment — reads the `segment_flow` MVT
 * tile's properties (segment_id, dir, highway, speed_ratio, los, confidence,
 * current_kph, free_flow_kph). The tile carries NO `observed_at`/freshness
 * attribute (unlike the `/segments.geojson` and `/flow` fallback, whose
 * `RoadFlowSegment.observedAt` IS populated), so there is deliberately no
 * "N min ago" row here.
 */
const POPUP_SPEC: PopupCardSpec = {
  titleField: "roadRef",
  rows: [
    { field: "currentSpeedText", labelKey: "panel.currentSpeed", variant: "row" },
    { field: "freeFlowSpeedText", labelKey: "panel.freeFlowSpeed", variant: "row" },
    { field: "ratioText", labelKey: "panel.ratio", variant: "row" },
    { field: "losText", labelKey: "panel.los", variant: "row" },
    { field: "confidenceText", labelKey: "confidence.label", variant: "row" },
  ],
};

/** `123.4` → `"123 km/h"`; anything non-finite → "" so the row drops. */
function formatKph(raw: unknown): string {
  const n = Number(raw);
  return Number.isFinite(n) ? `${Math.round(n)} km/h` : "";
}

/** OSM `highway` tag → a display-ready label ("motorway" → "Motorway"). */
function humanizeHighway(raw: string): string {
  const s = raw.replace(/_/g, " ");
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Derive the popup's display fields from a clicked feature's raw tile
 * properties. `roadRef` prefers a `ref` (e.g. "A1") over the humanized
 * `highway` tag — `ref` isn't on the `segment_flow` tile today but is kept as
 * a graceful fallback should a future tile revision add it.
 */
function buildPopupProperties(
  p: Record<string, unknown>,
  t: (key: string) => string,
): Record<string, unknown> {
  const ref = typeof p.ref === "string" && p.ref ? p.ref : undefined;
  const highway = typeof p.highway === "string" && p.highway ? p.highway : undefined;
  const los = typeof p.los === "string" && p.los ? p.los : undefined;
  const confidence = typeof p.confidence === "string" && p.confidence ? p.confidence : undefined;
  const speedRatio = Number(p.speed_ratio);
  return {
    roadRef: ref ?? (highway ? humanizeHighway(highway) : ""),
    currentSpeedText: formatKph(p.current_kph),
    freeFlowSpeedText: formatKph(p.free_flow_kph),
    ratioText: Number.isFinite(speedRatio) ? `${Math.round(speedRatio * 100)}%` : "",
    losText: los ? t(`los.${los}`) : "",
    confidenceText: confidence ? t(`confidence.${confidence}`) : "",
  };
}

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
            // Light, semi-transparent slate — a subtle outline for contrast and
            // to separate parallel carriageways/ramps, without reading as black.
            "line-color": "#7a8496",
            "line-opacity": 0.5,
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

  // Keep the latest translator in a ref so the imperative click handler
  // (bound once per effect) always uses the current locale.
  const t = useTranslations("trafficFlow");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  // Click popup + hover cursor on the color layer.
  useEffect(() => {
    void styleVersion;
    const glMap = mapRef.current;
    if (!glMap || !mapReady || !showFlow) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "280px",
        className: "omx-popup",
      })
        .setLngLat(e.lngLat)
        .setHTML(
          buildPopupCard(POPUP_SPEC, buildPopupProperties(properties, tRef.current), (k) =>
            tRef.current(k),
          ),
        )
        .addTo(glMap);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!glMap.getLayer(COLOR)) return;
      const hit = glMap.queryRenderedFeatures(e.point, { layers: [COLOR] });
      glMap.getCanvasContainer().style.cursor = hit.length > 0 ? "pointer" : "";
    };

    INTERACTIVE_LAYER_IDS.add(COLOR);
    glMap.on("click", COLOR, onClick);
    glMap.on("mousemove", onMouseMove);
    return () => {
      glMap.off("click", COLOR, onClick);
      glMap.off("mousemove", onMouseMove);
      glMap.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
      INTERACTIVE_LAYER_IDS.delete(COLOR);
    };
  }, [mapReady, mapRef, styleVersion, showFlow]);

  return null;
}
