"use client";

import { useOverlayExclusion } from "@openmapx/core";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { addLayerInSlot } from "@/components/map/layers/layerStack";
import { useStyleSyncedLayer } from "@/components/map/layers/useStyleSyncedLayer";
import {
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "@/components/map/overlay/mapInteractionArbiter";
import { buildPopupCard, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { flowColorExpression } from "@/lib/trafficFlowExpression";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { useTrafficFlowStore } from "./store";
import { TRAFFIC_FLOW_OPACITY_EXPRESSION } from "./visual-style";

const SRC = "omx-traffic-flow-src";
const CASING = "omx-traffic-flow-casing";
const COLOR = "omx-traffic-flow-color";
const SOURCE_LAYER = "segment_flow";
const LAYER_MIN_ZOOM = 6;

/**
 * Relative-speed (`speed_ratio` = current ÷ free-flow) → TomTom-style color
 * bands. A segment with no measured ratio (`speed_ratio` null — a declared-LoS
 * segment carrying only `los`, or a base segment with no `segment_speed` row)
 * is coloured by its `los` instead of defaulting to green: queuing → red,
 * stationary/blocked → dark red, heavy → orange, free_flow/unknown → green (so
 * a base segment still reads green, but a declared jam reads red).
 */
const COLOR_EXPR = flowColorExpression("speed_ratio", "los");

/**
 * Confidence → opacity: measured brightest, typical faintest. The floor (0.6 for
 * `typical`/no-live-data segments) is kept high enough that covered roads still
 * read as faint colour rather than letting the casing show through as black —
 * most segments are `typical` where live flow data is sparse.
 */
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
    addSource,
    addLayer: (m) => {
      addLayerInSlot(
        m,
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
        "traffic-flow",
        0,
      );
    },
    deps: [mapReady, styleVersion, mapRef, showFlow, martinBase],
  });

  useStyleSyncedLayer({
    map,
    visible: showFlow,
    sourceId: SRC,
    layerId: COLOR,
    addSource,
    addLayer: (m) => {
      addLayerInSlot(
        m,
        {
          id: COLOR,
          type: "line",
          source: SRC,
          "source-layer": SOURCE_LAYER,
          minzoom: LAYER_MIN_ZOOM,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR_EXPR,
            "line-opacity": TRAFFIC_FLOW_OPACITY_EXPRESSION,
            "line-width": COLOR_WIDTH_EXPR,
            "line-offset": OFFSET_EXPR,
          },
        },
        "traffic-flow",
        1,
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

  // Flow is intentionally lower priority than incidents when both overlays
  // have a rendered hit at the same point. The shared arbiter also owns the
  // pointer cursor and popup replacement for this map.
  useEffect(() => {
    void styleVersion;
    const glMap = mapRef.current;
    if (!glMap || !mapReady || !showFlow) return;

    const unregister = registerMapOverlayInteraction(glMap, {
      id: "traffic-flow",
      layerIds: [COLOR],
      priority: 10,
      onClick: ({ event, features }) => {
        const feature = features[0];
        if (!feature) return;
        const properties = (feature.properties ?? {}) as Record<string, unknown>;
        const popup = new maplibregl.Popup({
          closeButton: true,
          maxWidth: "280px",
          className: "omx-popup",
        })
          .setLngLat(event.lngLat)
          .setHTML(
            buildPopupCard(POPUP_SPEC, buildPopupProperties(properties, tRef.current), (k) =>
              tRef.current(k),
            ),
          );
        popupRef.current = popup;
        replaceMapOverlayPopup(glMap, popup);
      },
    });
    return () => {
      unregister();
      if (popupRef.current) {
        removeMapOverlayPopup(glMap, popupRef.current);
        popupRef.current = null;
      }
    };
  }, [mapReady, mapRef, styleVersion, showFlow]);

  return null;
}
