"use client";

import { formatDuration, useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { buildStackedPopupCard, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { isUnconfirmedCrowd } from "./evidence";
import { markerImageData, markerImageId, parseMarkerImageId, representativePoint } from "./markers";
// The named import also runs the module side-effect that registers the
// "road-conditions" overlay store (shared by the layer selector + legend).
import { horizonDaysParam, useRoadConditionsStore } from "./store";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const OVERLAY_ID = "road-conditions";
/**
 * The manifest domain the feeds are published under, which happens to spell the
 * same as this overlay's id — they are separate identifiers, so don't collapse
 * them: renaming the overlay would otherwise silently drop the credits.
 */
const CREDIT_DOMAIN = "road-conditions";
const MARKER_SOURCE = "omx-road-conditions-markers";
const LINE_SOURCE = "omx-road-conditions-lines";
const LINE_LAYER = "omx-road-conditions-line";
const MARKER_LAYER = "omx-road-conditions-markers";

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
    { field: "type", labelKey: "panel.type", format: "label", variant: "chip" },
    { field: "roadState", labelKey: "panel.roadState", format: "label", variant: "chip" },
    { field: "roads", labelKey: "panel.roads", variant: "row" },
    // Structured validity window (from the feed's validFrom/validTo, not the
    // free-text description — many feeds don't put it in the text). Pre-formatted
    // into `validity` at click time.
    { field: "validity", labelKey: "panel.validity", variant: "row" },
    // "Starts ⟨date⟩", set at click time for conditions that haven't begun —
    // without it a widened horizon reads the same as what's in effect now.
    { field: "startsAt", variant: "row" },
    // Pre-formatted "+X min" delay (Verlustzeit); set at click time when >= 60 s.
    { field: "delayText", labelKey: "panel.delay", variant: "row" },
    { field: "description", labelKey: "panel.description", variant: "block" },
  ],
};

/** Numeric severity rank — drives `symbol-sort-key` so the worst condition
 * renders on top where markers overlap, and orders the stacked popup. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
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

/** Whether a raw feature describes a condition that has not started yet. */
function isFutureCondition(p: Record<string, unknown>): boolean {
  if (p.isForecast === true) return true;
  if (typeof p.validFrom !== "string") return false;
  const from = Date.parse(p.validFrom);
  return !Number.isNaN(from) && from > Date.now();
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
    // Announced but not yet in effect. The upstream `isForecast` flag and a
    // future `validFrom` are independent signals — sources set the flag while
    // publishing vague or missing dates — so either one marks the feature.
    const future = isFutureCondition(p);

    // Marker placement points. A MultiPoint from these feeds carries only the
    // endpoints of a linear event ("zwischen X und Y") with NO road path between
    // them — often the two ends of a motorway closure kilometres apart. Drop a
    // marker at each real endpoint rather than a lone centroid plus a straight
    // chord: the chord cuts across a road that curves between the points, which
    // misrepresents the closure. Two honest points read better. All other
    // geometries → one representative point.
    let points: [number, number][] = [];
    if (
      geom?.type === "MultiPoint" &&
      Array.isArray(geom.coordinates) &&
      geom.coordinates.length > 0
    ) {
      points = geom.coordinates as [number, number][];
    } else {
      const rep = representativePoint(geom);
      if (rep) points = [rep];
    }

    if (points.length > 0) {
      const props: Record<string, unknown> = {
        headline: String(p.headline ?? ""),
        type,
        severity,
        attribution: attributionString(p.attribution),
        _icon: markerImageId(type, severity),
        // Stable id to dedupe overlapping markers into one popup, and a numeric
        // severity rank for symbol-sort-key (worst on top) + popup ordering.
        _id: p.id != null ? String(p.id) : String(p.headline ?? ""),
        _sev: SEVERITY_RANK[severity] ?? 0,
        // Flag an unconfirmed crowd report so styling/labeling can distinguish it
        // from a corroborated official condition. Booleans survive MapLibre's
        // property serialization; the actual dashed/badged rendering is pending.
        _unconfirmed: isUnconfirmedCrowd({
          originKind: typeof p.originKind === "string" ? p.originKind : null,
          evidenceState: typeof p.evidenceState === "string" ? p.evidenceState : null,
        }),
        // Drives the dimmed icon / dashed line for not-yet-started works, so a
        // widened horizon stays visually distinct from what's in effect now.
        future,
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
      // Carry the raw delay (Verlustzeit) through; formatted to "+X min" at click
      // time (popupCard has no generic duration formatter).
      if (typeof p.delaySeconds === "number") props.delaySeconds = p.delaySeconds;
      // Flatten affected-road refs into a compact label for the popup row.
      if (Array.isArray(p.roads) && p.roads.length > 0) {
        const names = (p.roads as Array<{ name?: unknown; ref?: unknown }>)
          .map((r) => String(r.ref ?? r.name ?? "").trim())
          .filter(Boolean);
        if (names.length > 0) props.roads = [...new Set(names)].join(", ");
      }
      for (const pt of points) {
        markerFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: pt },
          properties: props,
        });
      }
    }

    // Only genuine line geometry (a `gmlLineString` that follows the road) is
    // drawn as a line. We deliberately do NOT synthesise a chord for a 2-point
    // MultiPoint — there's no road path in the data, and the endpoint markers
    // above convey the extent without misrepresenting the road.
    if (geom && (geom.type === "LineString" || geom.type === "MultiLineString")) {
      lineFeatures.push({ type: "Feature", geometry: geom, properties: { severity, future } });
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
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the layers hidden, so a
  // country-sized viewport can't pull thousands of incidents.
  const minZoom = useOverlayMinZoom(OVERLAY_ID);
  const layerVisible = useOverlayLayerVisible(OVERLAY_ID);
  // This overlay's manifest declares no dataSources of its own — the feeds it
  // paints (NDW, Autobahn GmbH, Digitraffic, DriveBC, WZDx) are published by
  // the external `road-conditions-openconditions` provider registered under the
  // shared domain. Credit the domain, the same way overlay-traffic-flow does;
  // crediting this integration's own manifest registered nothing at all.
  useIntegrationDomainAttribution(CREDIT_DOMAIN, layerVisible);
  useOverlayExclusion(OVERLAY_ID, layerVisible);
  useLayerReanchor([LINE_LAYER, MARKER_LAYER], layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  // Keep the latest formatters/translator in refs so the imperative popup click
  // handler (bound once per effect) always uses the current prefs + locale.
  const dtf = useDateTimeFormat();
  const dtfRef = useRef(dtf);
  useEffect(() => {
    dtfRef.current = dtf;
  }, [dtf]);
  const t = useTranslations("roadConditions");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  // Legend filter state — threaded into the events query so filtering runs
  // server-side across every provider, not as client-side hiding.
  const filterTypes = useRoadConditionsStore((s) => s.types);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const horizon = useRoadConditionsStore((s) => s.horizon);

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < minZoom) return;
    const b = map.getBounds();
    const base = apiUrl.replace(/\/$/, "");
    const params = new URLSearchParams({
      bbox: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
    });
    if (filterTypes.length > 0) params.set("types", filterTypes.join(","));
    if (minSeverity !== "all") params.set("minSeverity", minSeverity);
    const horizonDays = horizonDaysParam(horizon);
    if (horizonDays !== undefined) params.set("horizonDays", horizonDays);
    const url = `${base}/api/integrations/road-conditions/events?${params.toString()}`;
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
  }, [apiUrl, mapRef, filterTypes, minSeverity, horizon, minZoom]);

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
              minzoom: minZoom,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": SEVERITY_LINE_COLOR,
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6, 16, 9],
                "line-opacity": ["case", ["get", "future"], 0.45, 0.7],
                "line-dasharray": [
                  "case",
                  ["get", "future"],
                  ["literal", [2, 1.5]],
                  ["literal", [1]],
                ],
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
              minzoom: minZoom,
              layout: {
                "icon-image": ["get", "_icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55, 16, 0.75],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                // Higher sort-key is drawn last (on top), so key by severity rank
                // — the worst condition's disc sits on top where markers overlap.
                "symbol-sort-key": ["get", "_sev"],
              },
              paint: {
                "icon-opacity": ["case", ["get", "future"], 0.55, 1],
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
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchData, minZoom]);

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
      // Collect every marker near the click — not just the top one — so several
      // conditions stacked at the same spot all stay reachable in a single popup
      // (linked works often share a segment: roadworks + its lane closure land on
      // the same point). The radius is ~one marker-width so touching/overlapping
      // discs are grouped while genuinely separate incidents stay independent.
      const r = 24;
      const box: [[number, number], [number, number]] = [
        [e.point.x - r, e.point.y - r],
        [e.point.x + r, e.point.y + r],
      ];
      const hits = map.getLayer(MARKER_LAYER)
        ? map.queryRenderedFeatures(box, { layers: [MARKER_LAYER] })
        : (e.features ?? []);
      if (hits.length === 0) return;

      // Dedupe by event id (one MultiPoint event renders a marker per endpoint),
      // format each condition's validity, then order most-severe first.
      const seen = new Set<string>();
      const entries: Record<string, unknown>[] = [];
      for (const h of hits) {
        const p = (h.properties ?? {}) as Record<string, unknown>;
        const id = String(p._id ?? p.headline ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        const validity = formatValidity(
          p.schedule,
          p.validFrom,
          p.validTo,
          dtfRef.current.dateTime,
          dtfRef.current.date,
        );
        const startsAt =
          p.future === true && typeof p.validFrom === "string"
            ? tRef.current("startsAt", {
                date: dtfRef.current.dateTime(p.validFrom),
              })
            : undefined;
        const delaySeconds = Number(p.delaySeconds);
        const delayText =
          Number.isFinite(delaySeconds) && delaySeconds >= 60
            ? `+${formatDuration(delaySeconds)}`
            : undefined;
        entries.push({
          ...p,
          ...(validity ? { validity } : {}),
          ...(startsAt ? { startsAt } : {}),
          ...(delayText ? { delayText } : {}),
        });
      }
      entries.sort((a, b) => (Number(b._sev) || 0) - (Number(a._sev) || 0));

      const top = e.features?.[0];
      const coords: [number, number] =
        top?.geometry?.type === "Point"
          ? (top.geometry.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(
          buildStackedPopupCard(
            POPUP_SPEC,
            entries,
            (k) => tRef.current(k),
            tRef.current("panel.conditionsHere", { count: entries.length }),
          ),
        )
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
