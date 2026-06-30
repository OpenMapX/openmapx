"use client";

import { useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { buildPopupCard, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { markerImageData, markerImageId, parseMarkerImageId, representativePoint } from "./markers";
// Registers the "road-conditions" overlay store the layer selector toggles.
import "./store";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const OVERLAY_ID = "road-conditions";
const MARKER_SOURCE = "omx-road-conditions-markers";
const LINE_SOURCE = "omx-road-conditions-lines";
const LINE_LAYER = "omx-road-conditions-line";
const MARKER_LAYER = "omx-road-conditions-markers";
const MIN_ZOOM = 5;

/** Affected-segment line color by severity (matches the marker disc ramp). */
const SEVERITY_LINE_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "severity"],
  "critical",
  "#7e0023",
  "high",
  "#cc0033",
  "medium",
  "#ff9933",
  "low",
  "#ffde33",
  "#8a8a8a",
];

/** Popup card layout — defined in code, full freedom (no manifest schema). */
const POPUP_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  attributionField: "attribution",
  rows: [
    { field: "type", label: "Type", format: "label", variant: "chip" },
    { field: "roadState", label: "Status", format: "label", variant: "chip" },
    // Structured validity window (from the feed's validFrom/validTo, not the
    // free-text description — many feeds don't put it in the text). Pre-formatted
    // into `validity` at click time.
    { field: "validity", label: "Active", variant: "row" },
    { field: "description", label: "Details", variant: "block" },
  ],
};

interface ScheduleEntry {
  startTime?: string;
  endTime?: string;
  startDate?: string;
  endDate?: string;
  byDay?: string[];
}

/**
 * Format the structured validity for the popup. A recurring `schedule` (a
 * schema.org Schedule, e.g. a nightly closure) is shown as its day(s) + band +
 * date range, e.g. "Mo, Tu, We, 08:00–17:00, 29 Jun 2026 – 1 Jul 2026";
 * otherwise the absolute from–until range, e.g.
 * "10 Jul 2026, 22:00 – 13 Jul 2026, 05:00". An open end is shown as "…".
 * Returns "" when nothing is known (ongoing / undated) so the row drops.
 * Schedule times are the source's local clock (`scheduleTimezone`), shown as-is.
 */
function formatValidity(
  scheduleJson: unknown,
  from: unknown,
  to: unknown,
  fmtDateTime: (value: string | number | Date) => string,
  fmtDate: (value: string | number | Date) => string,
): string {
  if (typeof scheduleJson === "string" && scheduleJson) {
    try {
      const windows = JSON.parse(scheduleJson) as ScheduleEntry[];
      const hhmm = (t?: string) => (t ? t.slice(0, 5) : "");
      const parts = windows
        .map((w) => {
          const days = w.byDay && w.byDay.length > 0 ? w.byDay.join(", ") : "";
          const band =
            w.startTime && w.endTime
              ? `${hhmm(w.startTime)}–${hhmm(w.endTime)}`
              : w.startTime
                ? `from ${hhmm(w.startTime)}`
                : "";
          const range =
            w.startDate && w.endDate
              ? `${fmtDate(w.startDate)} – ${fmtDate(w.endDate)}`
              : w.startDate
                ? fmtDate(w.startDate)
                : "";
          return [days, band, range].filter(Boolean).join(", ");
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    } catch {
      // Malformed schedule → fall through to the plain range.
    }
  }
  const f = typeof from === "string" && from ? fmtDateTime(from) : "";
  const t = typeof to === "string" && to ? fmtDateTime(to) : "";
  if (!f && !t) return "";
  return `${f || "…"} – ${t || "…"}`;
}

/** Collapse the attribution object into a single credit string for the popup. */
function attributionString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "";
    const license = typeof o.license === "string" ? o.license : "";
    return provider && license ? `${provider} · ${license}` : provider || license;
  }
  return "";
}

interface RawFeature {
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/**
 * Build the marker + line source data from the raw /events FeatureCollection:
 * exactly ONE marker per incident (placed at a representative point with the
 * disc+glyph baked into a single icon image), and the original line geometries
 * for the affected-segment lines. Marker properties are flattened to primitives
 * so they survive MapLibre's feature-property serialization.
 */
function buildSources(features: RawFeature[]): { markers: GeoJsonData; lines: GeoJsonData } {
  const markerFeatures: unknown[] = [];
  const lineFeatures: unknown[] = [];

  for (const f of features) {
    const p = f.properties ?? {};
    const geom = f.geometry ?? null;
    const type = String(p.type ?? "other");
    const severity = String(p.severity ?? "unknown");

    const rep = representativePoint(geom);
    if (rep) {
      const props: Record<string, unknown> = {
        headline: String(p.headline ?? ""),
        type,
        severity,
        attribution: attributionString(p.attribution),
        _icon: markerImageId(type, severity),
      };
      if (p.roadState) props.roadState = String(p.roadState);
      // Raw ISO validity bounds + recurring schedule — formatted into a human
      // "Active …" string at click time (needs the user's locale/time-format
      // prefs). Carried as primitives/JSON so they survive MapLibre's property
      // serialization.
      if (p.validFrom) props.validFrom = String(p.validFrom);
      if (p.validTo) props.validTo = String(p.validTo);
      if (Array.isArray(p.schedule) && p.schedule.length > 0) {
        props.schedule = JSON.stringify(p.schedule);
      }
      if (p.description) props.description = String(p.description);
      markerFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: rep },
        properties: props,
      });
    }

    if (geom && (geom.type === "LineString" || geom.type === "MultiLineString")) {
      lineFeatures.push({ type: "Feature", geometry: geom, properties: { severity } });
    }
  }

  return {
    markers: { type: "FeatureCollection", features: markerFeatures } as GeoJsonData,
    lines: { type: "FeatureCollection", features: lineFeatures } as GeoJsonData,
  };
}

export function RoadConditionsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const layerVisible = useOverlayLayerVisible(OVERLAY_ID);
  useIntegrationAttribution(OVERLAY_ID, layerVisible);
  useOverlayExclusion(OVERLAY_ID, layerVisible);
  useLayerReanchor([LINE_LAYER, MARKER_LAYER], layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  // Keep the latest formatters in a ref so the imperative popup click handler
  // (bound once per effect) always formats validity per the current prefs.
  const dtf = useDateTimeFormat();
  const dtfRef = useRef(dtf);
  useEffect(() => {
    dtfRef.current = dtf;
  }, [dtf]);

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < MIN_ZOOM) return;
    const b = map.getBounds();
    const base = apiUrl.replace(/\/$/, "");
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    const url = `${base}/api/integrations/road-conditions/events?bbox=${bbox}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const fc = (await res.json()) as { features?: RawFeature[] };
      const { markers, lines } = buildSources(Array.isArray(fc.features) ? fc.features : []);
      (map.getSource(MARKER_SOURCE) as GeoJSONSource | undefined)?.setData(markers);
      (map.getSource(LINE_SOURCE) as GeoJSONSource | undefined)?.setData(lines);
    } catch {
      // Silent fetch failure — overlay stays as-is.
    }
  }, [apiUrl, mapRef]);

  // Bake a disc+glyph marker image on demand for each (type, severity) the
  // symbol layer requests. Synchronous canvas render → no flicker, no warnings.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const onMissing = (e: { id: string }) => {
      if (map.hasImage(e.id)) return;
      const parsed = parseMarkerImageId(e.id);
      if (!parsed) return;
      const data = markerImageData(parsed.type, parsed.severity);
      if (data && !map.hasImage(e.id)) map.addImage(e.id, data, { pixelRatio: 2 });
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapRef, mapReady]);

  // Add/remove source + layers, re-attaching after a style swap.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const sync = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(MARKER_LAYER)) map.removeLayer(MARKER_LAYER);
          if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
          if (map.getSource(MARKER_SOURCE)) map.removeSource(MARKER_SOURCE);
          if (map.getSource(LINE_SOURCE)) map.removeSource(LINE_SOURCE);
        } catch {
          // In-flight render — ignore.
        }
        popupRef.current?.remove();
        return;
      }
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }
      try {
        if (!map.getSource(LINE_SOURCE)) {
          map.addSource(LINE_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        if (!map.getSource(MARKER_SOURCE)) {
          map.addSource(MARKER_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        const before = getFirstSymbolLayerId(map);
        if (!map.getLayer(LINE_LAYER)) {
          map.addLayer(
            {
              id: LINE_LAYER,
              type: "line",
              source: LINE_SOURCE,
              minzoom: MIN_ZOOM,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": SEVERITY_LINE_COLOR,
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6, 16, 9],
                "line-opacity": 0.7,
              },
            },
            before,
          );
        }
        if (!map.getLayer(MARKER_LAYER)) {
          map.addLayer(
            {
              id: MARKER_LAYER,
              type: "symbol",
              source: MARKER_SOURCE,
              minzoom: MIN_ZOOM,
              layout: {
                "icon-image": ["get", "_icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55, 16, 0.75],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            },
            before,
          );
          INTERACTIVE_LAYER_IDS.add(MARKER_LAYER);
        }
        void fetchData();
      } catch {
        // Style not ready — styledata will retry.
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchData]);

  // bbox-driven refetch on pan/zoom.
  const debouncedFetch = useDebouncedCallback(() => fetchData(), 800);
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, debouncedFetch]);

  // Click popup + hover cursor on markers.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const geom = f.geometry;
      const coords: [number, number] =
        geom?.type === "Point"
          ? (geom.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];
      const validity = formatValidity(
        props.schedule,
        props.validFrom,
        props.validTo,
        dtfRef.current.dateTime,
        dtfRef.current.date,
      );
      const popupProps = validity ? { ...props, validity } : props;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(buildPopupCard(POPUP_SPEC, popupProps))
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(MARKER_LAYER)) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: [MARKER_LAYER] });
      map.getCanvasContainer().style.cursor = hit.length > 0 ? "pointer" : "";
    };

    map.on("click", MARKER_LAYER, onClick);
    map.on("mousemove", onMouseMove);
    return () => {
      map.off("click", MARKER_LAYER, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // Deregister the interactive layer id on unmount.
  useEffect(() => {
    return () => {
      INTERACTIVE_LAYER_IDS.delete(MARKER_LAYER);
    };
  }, []);

  return null;
}

export default RoadConditionsLayer;
