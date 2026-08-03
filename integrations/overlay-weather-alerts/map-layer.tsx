"use client";

import { escapeHtml, useOverlayExclusion } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useWeatherAlertStore } from "./store";

const SOURCE_ID = "openmapx-weather-alerts-source";
const FILL_LAYER_ID = "openmapx-weather-alerts-fill";
const LINE_LAYER_ID = "openmapx-weather-alerts-outline";
const CIRCLE_LAYER_ID = "openmapx-weather-alerts-points";
const ALL_LAYER_IDS = [FILL_LAYER_ID, LINE_LAYER_ID, CIRCLE_LAYER_ID] as const;
const REFRESH_INTERVAL_MS = 300_000; // 5 minutes

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

export function WeatherAlertLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const t = useTranslations("weatherAlerts");
  const layerVisible = useWeatherAlertStore((s) => s.layerVisible);
  const activeSeverities = useWeatherAlertStore((s) => s.activeSeverities);
  const setLoading = useWeatherAlertStore((s) => s.setLoading);
  const setAlertCount = useWeatherAlertStore((s) => s.setAlertCount);
  const setLastUpdated = useWeatherAlertStore((s) => s.setLastUpdated);

  useIntegrationAttribution("overlay-weather-alerts", layerVisible);
  useOverlayExclusion("weather-alerts", layerVisible);

  const popupRef = useRef<maplibregl.Popup | null>(null);
  const fetchedRef = useRef(false);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });

  const fetchAlerts = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const url = `${env.apiUrl}/api/integrations/overlay-weather-alerts/events`;

    const request = beginRequest();
    setLoading(true);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent() || !res.ok) return;
      const data = await res.json();
      if (!request.isCurrent()) return;
      setAlertCount(data.features?.length ?? 0);
      setLastUpdated(Date.now());

      publishGeoJson([{ sourceId: SOURCE_ID, data }]);
    } catch {
      // silent
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [beginRequest, env.apiUrl, mapRef, publishGeoJson, setLoading, setAlertCount, setLastUpdated]);

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
        fetchAlerts();
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

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;
    const interval = setInterval(() => {
      fetchAlerts();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [layerVisible, fetchAlerts]);

  // Click popup
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | null>;

      const title = escapeHtml(String(p.title || "Weather Alert"));
      const severity = String(p.severity || "Unknown");
      const sevColor = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Unknown;
      const event = escapeHtml(String(p.event || ""));
      const areaDesc = escapeHtml(String(p.areaDesc || ""));
      const onset = formatTime(p.onset ? String(p.onset) : null);
      const expires = formatTime(p.expires ? String(p.expires) : null);
      const description = p.description ? escapeHtml(String(p.description).slice(0, 300)) : null;
      const instruction = p.instruction ? escapeHtml(String(p.instruction).slice(0, 200)) : null;
      const sourceUrl = p.sourceUrl ? String(p.sourceUrl) : null;
      const source =
        p.source === "dwd"
          ? "DWD"
          : p.source === "eccc"
            ? "ECCC"
            : p.source === "meteoalarm"
              ? "MeteoAlarm"
              : "NOAA";

      // Get click coordinates — for polygons use the click point, for points use feature coords
      const coords: [number, number] =
        p.geometryType === "point"
          ? ((f.geometry as { coordinates: number[] }).coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];

      const timeRange =
        onset || expires
          ? `<div style="font-size:12px;color:#666;margin-bottom:4px">${onset}${onset && expires ? " — " : ""}${expires}</div>`
          : "";

      const html = `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:220px;max-width:300px">
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">${title}</div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px">
            <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;color:#fff;background:${sevColor}">
              ${escapeHtml(t(severity))}
            </span>
            ${event && event !== title ? `<span style="font-size:11px;color:#666">${event}</span>` : ""}
          </div>
          ${areaDesc ? `<div style="font-size:12px;color:#444;margin-bottom:4px">${areaDesc}</div>` : ""}
          ${timeRange}
          ${description ? `<div style="font-size:12px;color:#555;margin-bottom:4px">${description}${String(p.description || "").length > 300 ? "..." : ""}</div>` : ""}
          ${instruction ? `<div style="font-size:11px;color:#666;font-style:italic;margin-bottom:4px">${instruction}${String(p.instruction || "").length > 200 ? "..." : ""}</div>` : ""}
          <div style="font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:4px;margin-top:4px">
            ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${source}</a>` : source}
          </div>
        </div>`;

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
  }, [mapReady, styleVersion, mapRef, layerVisible, t]);

  return null;
}
