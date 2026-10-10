"use client";

import { escapeHtml, sanitizeUrl, useOverlayExclusion } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useSourceAttributions } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useWeatherAlertStore } from "./store";

const SOURCE_ID = "openmapx-weather-alerts-source";
const FILL_LAYER_ID = "openmapx-weather-alerts-fill";
const LINE_LAYER_ID = "openmapx-weather-alerts-outline";
const CIRCLE_LAYER_ID = "openmapx-weather-alerts-points";
const ALL_LAYER_IDS = [FILL_LAYER_ID, LINE_LAYER_ID, CIRCLE_LAYER_ID] as const;
const REFRESH_INTERVAL_MS = 120_000;
/**
 * How long the layer shows alerts after its last successful load. MeteoAlarm's
 * terms allow a redistributor ten minutes behind its site: OpenConditions
 * serves at most 300 s behind, the route caches 60 s, and the layer keeps the
 * remaining 240 s.
 */
export const ALERT_DISPLAY_MAX_AGE_MS = 240_000;
const NO_SOURCES: readonly string[] = [];

/** The route's answer: the alerts as GeoJSON, and the feed ids behind them. */
type AlertCollection = GeoJSON.FeatureCollection & { sources?: unknown };

const NO_ALERTS: AlertCollection = { type: "FeatureCollection", features: [] };

/** The alerts still in force at `now`: one whose expiry has passed is not drawn. */
export function currentAlerts(data: AlertCollection, now: number): AlertCollection {
  return {
    ...data,
    features: data.features.filter((f) => {
      const expires: unknown = f.properties?.expires;
      return typeof expires !== "string" || !(Date.parse(expires) <= now);
    }),
  };
}

export const SEVERITY_COLORS: Record<string, string> = {
  Extreme: "#991b1b",
  Severe: "#ea580c",
  Moderate: "#d97706",
  Minor: "#ca8a04",
  Unknown: "#6b7280",
};

function buildSeverityColorExpr(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "severity"],
    "Extreme",
    SEVERITY_COLORS.Extreme,
    "Severe",
    SEVERITY_COLORS.Severe,
    "Moderate",
    SEVERITY_COLORS.Moderate,
    "Minor",
    SEVERITY_COLORS.Minor,
    "Unknown",
    SEVERITY_COLORS.Unknown,
    "#6b7280",
  ] as maplibregl.ExpressionSpecification;
}

function buildPolygonFilter(active: Set<string>): maplibregl.ExpressionSpecification {
  return [
    "all",
    ["==", ["get", "geometryType"], "polygon"],
    ["in", ["get", "severity"], ["literal", [...active]]],
  ] as maplibregl.ExpressionSpecification;
}

function buildPointFilter(active: Set<string>): maplibregl.ExpressionSpecification {
  return [
    "all",
    ["==", ["get", "geometryType"], "point"],
    ["in", ["get", "severity"], ["literal", [...active]]],
  ] as maplibregl.ExpressionSpecification;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** MapLibre hands list properties back as JSON text. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface AlertPopupLabels {
  issued: string;
  issuer: string;
  /** The severity in the reader's language. */
  severityText: string;
  /** The link text of the alert's own page. */
  moreInfo: string;
}

/** The data source an alert came from: its name and its own site (MeteoAlarm's terms ask for a link to it). */
export interface AlertPopupSource {
  name: string;
  url?: string | null;
}

export function buildAlertPopupHtml(
  p: Record<string, unknown>,
  labels: AlertPopupLabels,
  dataSource: AlertPopupSource,
): string {
  const title = escapeHtml(String(p.title || "Weather Alert"));
  const severity = String(p.severity || "Unknown");
  const sevColor = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Unknown;
  const event = escapeHtml(String(p.event || ""));
  const areaDesc = escapeHtml(String(p.areaDesc || ""));
  const onset = formatTime(p.onset ? String(p.onset) : null);
  const expires = formatTime(p.expires ? String(p.expires) : null);
  const issued = formatTime(p.sent ? String(p.sent) : null);
  const issuer = p.senderName ? escapeHtml(String(p.senderName)) : "";
  const notices = stringList(p.notices);
  // The alert's own page (CAP `web`): for MeteoAlarm the national service's, not MeteoAlarm's.
  const alertUrl = sanitizeUrl(String(p.sourceUrl ?? ""));
  const sourceUrl = sanitizeUrl(dataSource.url ?? "");
  const source = escapeHtml(dataSource.name);
  const linkStyle =
    'target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline"';
  const sourceLink = sourceUrl ? `<a href="${sourceUrl}" ${linkStyle}>${source}</a>` : source;
  const alertLink = alertUrl
    ? ` · <a href="${alertUrl}" ${linkStyle}>${escapeHtml(labels.moreInfo)}</a>`
    : "";

  // The publisher's text is shown whole: some licences forbid altering an alert's content.
  const description = p.description ? escapeHtml(String(p.description)) : null;
  const instruction = p.instruction ? escapeHtml(String(p.instruction)) : null;
  const fullText = [
    description ? `<div style="margin-bottom:4px">${description}</div>` : "",
    instruction ? `<div style="font-style:italic">${instruction}</div>` : "",
  ].join("");

  const timeRange =
    onset || expires
      ? `<div style="font-size:12px;color:#666;margin-bottom:4px">${onset}${onset && expires ? " — " : ""}${expires}</div>`
      : "";
  const issuedLine =
    issued || issuer
      ? `<div style="font-size:11px;color:#666;margin-bottom:4px">${[
          issued ? `${escapeHtml(labels.issued)}: ${issued}` : "",
          issuer ? `${escapeHtml(labels.issuer)}: ${issuer}` : "",
        ]
          .filter(Boolean)
          .join(" · ")}</div>`
      : "";

  return `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:220px;max-width:300px">
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">${title}</div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px">
            <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;color:#fff;background:${sevColor}">
              ${escapeHtml(labels.severityText)}
            </span>
            ${event && event !== title ? `<span style="font-size:11px;color:#666">${event}</span>` : ""}
          </div>
          ${areaDesc ? `<div style="font-size:12px;color:#444;margin-bottom:4px">${areaDesc}</div>` : ""}
          ${timeRange}
          ${issuedLine}
          ${fullText ? `<div style="font-size:12px;color:#555;margin-bottom:4px;max-height:160px;overflow-y:auto;white-space:pre-wrap">${fullText}</div>` : ""}
          ${notices.map((n) => `<div style="font-size:10px;color:#777;margin-bottom:4px">${escapeHtml(n)}</div>`).join("")}
          <div style="font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:4px;margin-top:4px">
            ${sourceLink}${alertLink}
          </div>
        </div>`;
}

export function WeatherAlertLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const t = useTranslations("weatherAlerts");
  const layerVisible = useWeatherAlertStore((s) => s.layerVisible);
  const activeSeverities = useWeatherAlertStore((s) => s.activeSeverities);
  const setLoading = useWeatherAlertStore((s) => s.setLoading);
  const setAlertCount = useWeatherAlertStore((s) => s.setAlertCount);
  const setLastUpdated = useWeatherAlertStore((s) => s.setLastUpdated);
  const setUnavailable = useWeatherAlertStore((s) => s.setUnavailable);

  const [sourceIds, setSourceIds] = useState<readonly string[]>(NO_SOURCES);
  useSourceAttributions("weather-alerts", layerVisible ? sourceIds : NO_SOURCES);
  useOverlayExclusion("weather-alerts", layerVisible);

  const popupRef = useRef<maplibregl.Popup | null>(null);
  const fetchedRef = useRef(false);
  /** The last successful load and when it arrived; null once it is too old to show. */
  const lastLoadRef = useRef<{ at: number; data: AlertCollection } | null>(null);
  /** Clears the layer when the last successful load passes the bound, whatever the refreshes do. */
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });

  const draw = useCallback(
    (data: AlertCollection) => {
      const current = currentAlerts(data, Date.now());
      publishGeoJson([{ sourceId: SOURCE_ID, data: current }]);
      setAlertCount(current.features.length);
    },
    [publishGeoJson, setAlertCount],
  );

  /**
   * Clears the layer once its last successful load is older than the bound,
   * so a failed refresh or a sleeping tab never shows alerts past it; else
   * redraws it without the alerts that have expired since.
   */
  const expireStale = useCallback(() => {
    const last = lastLoadRef.current;
    if (!last) return;
    if (Date.now() - last.at <= ALERT_DISPLAY_MAX_AGE_MS) {
      draw(last.data);
      return;
    }
    lastLoadRef.current = null;
    popupRef.current?.remove();
    draw(NO_ALERTS);
    setSourceIds(NO_SOURCES);
  }, [draw]);

  const fetchAlerts = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const url = `${env.apiUrl}/api/integrations/overlay-weather-alerts/events?lang=${encodeURIComponent(locale)}`;

    const request = beginRequest();
    setLoading(true);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent()) return;
      if (!res.ok) {
        setUnavailable(true);
        expireStale();
        return;
      }
      const data = (await res.json()) as AlertCollection;
      if (!request.isCurrent()) return;
      lastLoadRef.current = { at: Date.now(), data };
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(expireStale, ALERT_DISPLAY_MAX_AGE_MS + 1);
      setUnavailable(false);
      setLastUpdated(Date.now());
      draw(data);
      const ids: string[] = Array.isArray(data.sources) ? data.sources.map(String) : [];
      setSourceIds((prev) =>
        prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
      );
    } catch {
      // A network failure is a failed refresh; an aborted request is not.
      if (request.isCurrent()) {
        setUnavailable(true);
        expireStale();
      }
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [
    beginRequest,
    draw,
    env.apiUrl,
    expireStale,
    locale,
    mapRef,
    setLoading,
    setLastUpdated,
    setUnavailable,
  ]);

  // Main layer lifecycle
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!layerVisible) {
        try {
          for (const id of ALL_LAYER_IDS) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // ignore
        }
        unregisterLayerSlot(FILL_LAYER_ID);
        unregisterLayerSlot(LINE_LAYER_ID);
        unregisterLayerSlot(CIRCLE_LAYER_ID);
        popupRef.current?.remove();
        fetchedRef.current = false;
        lastLoadRef.current = null;
        setAlertCount(0);
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer(FILL_LAYER_ID)) {
        addLayerInSlot(
          map,
          {
            id: FILL_LAYER_ID,
            type: "fill",
            source: SOURCE_ID,
            filter: buildPolygonFilter(activeSeverities),
            paint: {
              "fill-color": buildSeverityColorExpr(),
              "fill-opacity": 0.25,
            },
          },
          "area-overlays",
          1,
        );
      }

      if (!map.getLayer(LINE_LAYER_ID)) {
        addLayerInSlot(
          map,
          {
            id: LINE_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            filter: buildPolygonFilter(activeSeverities),
            paint: {
              "line-color": buildSeverityColorExpr(),
              "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 8, 2, 12, 3],
              "line-opacity": 0.7,
            },
          },
          "overlay-lines",
          10,
        );
      }

      if (!map.getLayer(CIRCLE_LAYER_ID)) {
        addLayerInSlot(
          map,
          {
            id: CIRCLE_LAYER_ID,
            type: "circle",
            source: SOURCE_ID,
            filter: buildPointFilter(activeSeverities),
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 6, 5, 10, 8, 14],
              "circle-color": buildSeverityColorExpr(),
              "circle-opacity": 0.85,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.5,
            },
          },
          "overlay-points",
          24,
        );
      }

      if (!fetchedRef.current) {
        fetchedRef.current = true;
        // The fetch handles its own failures and loading state.
        void fetchAlerts();
      }
    };

    if (!layerVisible) {
      syncLayer();
      return;
    }

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, activeSeverities, fetchAlerts, setAlertCount]);

  // Update filters when activeSeverities changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    if (map.getLayer(FILL_LAYER_ID)) {
      map.setFilter(FILL_LAYER_ID, buildPolygonFilter(activeSeverities));
    }
    if (map.getLayer(LINE_LAYER_ID)) {
      map.setFilter(LINE_LAYER_ID, buildPolygonFilter(activeSeverities));
    }
    if (map.getLayer(CIRCLE_LAYER_ID)) {
      map.setFilter(CIRCLE_LAYER_ID, buildPointFilter(activeSeverities));
    }
  }, [mapRef, mapReady, layerVisible, activeSeverities]);

  useEffect(
    () => () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    },
    [],
  );

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;
    const interval = setInterval(() => {
      // A refresh that never answers must not keep old alerts up either.
      expireStale();
      void fetchAlerts();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [layerVisible, fetchAlerts, expireStale]);

  // A tab that slept or lost focus may hold alerts past the bound: drop them at once, and
  // refetch as soon as the tab is visible again.
  useEffect(() => {
    if (!layerVisible) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      expireStale();
      void fetchAlerts();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", expireStale);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", expireStale);
    };
  }, [layerVisible, fetchAlerts, expireStale]);

  // Click popup
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, unknown>;
      const severity = String(p.severity || "Unknown");
      const sourceId = String(p.source ?? "");
      const dataSource = registry.findDataSource(sourceId);

      // Get click coordinates — for polygons use the click point, for points use feature coords
      const coords: [number, number] =
        p.geometryType === "point"
          ? ((f.geometry as { coordinates: number[] }).coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];

      const html = buildAlertPopupHtml(
        p,
        {
          issued: t("issued"),
          issuer: t("issuer"),
          severityText: t(severity),
          moreInfo: t("moreInfo"),
        },
        { name: dataSource?.name ?? sourceId, url: dataSource?.url },
      );

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "320px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const layers = ALL_LAYER_IDS.filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [...layers] });
      map.getCanvasContainer().style.cursor = features.length > 0 ? "pointer" : "";
    };

    for (const id of ALL_LAYER_IDS) {
      map.on("click", id, onClick);
      INTERACTIVE_LAYER_IDS.add(id);
    }
    map.on("mousemove", onMouseMove);

    return () => {
      for (const id of ALL_LAYER_IDS) {
        map.off("click", id, onClick);
        INTERACTIVE_LAYER_IDS.delete(id);
      }
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, t, registry]);

  return null;
}
