"use client";

import {
  buildIntegrationAttribution,
  escapeHtml,
  relativeTime,
  sanitizeUrl,
  useIntegrationRegistry,
  useOverlayExclusion,
} from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useEarthquakeStore } from "./store";

const SOURCE_ID = "openmapx-earthquakes-source";
const CIRCLE_LAYER_ID = "openmapx-earthquakes-circles";
const HEATMAP_LAYER_ID = "openmapx-earthquakes-heatmap";
const PULSE_LAYER_ID = "openmapx-earthquakes-pulse";

const MAG_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["exponential", 2],
  ["get", "mag"],
  0,
  2,
  2,
  3,
  3,
  5,
  4,
  8,
  5,
  13,
  6,
  20,
  7,
  30,
  8,
  42,
];

function scaledMagRadius(factor: number): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["get", "mag"],
    0,
    2 * factor,
    2,
    3 * factor,
    3,
    5 * factor,
    4,
    8 * factor,
    5,
    13 * factor,
    6,
    20 * factor,
    7,
    30 * factor,
    8,
    42 * factor,
  ];
}

/** Zoom-based radius: top-level zoom interpolation with magnitude sub-expressions at each stop. */
const CIRCLE_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  2,
  scaledMagRadius(0.6),
  5,
  scaledMagRadius(1.0),
  8,
  scaledMagRadius(1.4),
  12,
  scaledMagRadius(2.0),
];

const DEPTH_COLORS: [number, string][] = [
  [0, "#ff4500"],
  [33, "#ff8c00"],
  [70, "#ffd700"],
  [150, "#32cd32"],
  [300, "#1e90ff"],
  [500, "#8b00ff"],
];

const RECENCY_COLORS: [number, string][] = [
  [0, "#ef4444"],
  [3_600_000, "#f97316"],
  [86_400_000, "#eab308"],
  [604_800_000, "#94a3b8"],
];

function circleColorExpr(mode: "depth" | "recency"): maplibregl.ExpressionSpecification {
  return mode === "depth"
    ? ["interpolate", ["linear"], ["get", "depth"], ...DEPTH_COLORS.flat()]
    : ["interpolate", ["linear"], ["get", "ageMs"], ...RECENCY_COLORS.flat()];
}

const MAG_SEVERITY: [number, string, string][] = [
  [0, "Micro", "#94a3b8"],
  [2.0, "Minor", "#22c55e"],
  [4.0, "Light", "#eab308"],
  [5.0, "Moderate", "#f97316"],
  [6.0, "Strong", "#ef4444"],
  [7.0, "Major", "#dc2626"],
  [8.0, "Great", "#7f1d1d"],
];

function magColor(mag: number): string {
  let color = MAG_SEVERITY[0][2];
  for (const [threshold, , c] of MAG_SEVERITY) {
    if (mag >= threshold) color = c;
  }
  return color;
}

function magSeverityLabel(mag: number): string {
  let label = MAG_SEVERITY[0][1];
  for (const [threshold, l] of MAG_SEVERITY) {
    if (mag >= threshold) label = l;
  }
  return label;
}

function depthLabel(depth: number): string {
  if (depth < 70) return "Shallow";
  if (depth < 300) return "Intermediate";
  return "Deep";
}

export function EarthquakeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-earthquakes");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const layerVisible = useEarthquakeStore((s) => s.layerVisible);
  const timeRange = useEarthquakeStore((s) => s.timeRange);
  const minMagnitude = useEarthquakeStore((s) => s.minMagnitude);
  const colorMode = useEarthquakeStore((s) => s.colorMode);
  const showHeatmap = useEarthquakeStore((s) => s.showHeatmap);
  const setLoading = useEarthquakeStore((s) => s.setLoading);
  const setLastUpdated = useEarthquakeStore((s) => s.setLastUpdated);
  useOverlayExclusion("earthquakes", layerVisible);
  useLayerReanchor([CIRCLE_LAYER_ID, PULSE_LAYER_ID, HEATMAP_LAYER_ID], layerVisible);
  const t = useTranslations("earthquakes");
  const fetchedRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pulseAnimRef = useRef<number | null>(null);

  const fetchEarthquakes = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const { apiUrl } = env;
    const url = `${apiUrl}/api/integrations/overlay-earthquakes/earthquakes?timeRange=${timeRange}&minMagnitude=${minMagnitude}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
        setLastUpdated(Date.now());
      }
    } catch {
      // Silent fetch failure
    } finally {
      setLoading(false);
    }
  }, [env, mapRef, timeRange, minMagnitude, setLoading, setLastUpdated]);

  // Layer management
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(PULSE_LAYER_ID)) map.removeLayer(PULSE_LAYER_ID);
          if (map.getLayer(HEATMAP_LAYER_ID)) map.removeLayer(HEATMAP_LAYER_ID);
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        popupRef.current?.remove();
        fetchedRef.current = false;
        if (pulseAnimRef.current !== null) {
          cancelAnimationFrame(pulseAnimRef.current);
          pulseAnimRef.current = null;
        }
        return;
      }

      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            attribution: attributionHtml,
          });
        }

        const beforeLayer = getFirstSymbolLayerId(map);

        // Circle layer
        if (!map.getLayer(CIRCLE_LAYER_ID)) {
          map.addLayer(
            {
              id: CIRCLE_LAYER_ID,
              type: "circle",
              source: SOURCE_ID,
              paint: {
                "circle-radius": CIRCLE_RADIUS_EXPR,
                "circle-color": circleColorExpr(useEarthquakeStore.getState().colorMode),
                "circle-opacity": 0.85,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
              },
            },
            beforeLayer,
          );
        }

        // Pulse layer for events < 1 hour old
        if (!map.getLayer(PULSE_LAYER_ID)) {
          map.addLayer(
            {
              id: PULSE_LAYER_ID,
              type: "circle",
              source: SOURCE_ID,
              filter: ["<", ["get", "ageMs"], 3_600_000],
              paint: {
                "circle-radius": MAG_RADIUS_EXPR,
                "circle-color": "#ef4444",
                "circle-opacity": 0,
                "circle-stroke-color": "#ef4444",
                "circle-stroke-width": 2,
                "circle-stroke-opacity": 0,
              },
            },
            beforeLayer,
          );
          startPulseAnimation(map);
        }

        if (!fetchedRef.current) {
          fetchedRef.current = true;
          fetchEarthquakes();
        }
      } catch {
        // Style not ready — styledata will retry
      }
    };

    if (!layerVisible) {
      syncLayers();
      return;
    }

    // Reset fetchedRef so syncLayers will fetch (handles filter param changes via fetchEarthquakes)
    fetchedRef.current = false;
    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchEarthquakes]);

  // When colorMode changes, rebuild circle layer color expression
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !map.getLayer(CIRCLE_LAYER_ID)) return;

    try {
      map.setPaintProperty(CIRCLE_LAYER_ID, "circle-color", circleColorExpr(colorMode));
    } catch {
      // Layer may not exist yet
    }
  }, [mapRef, mapReady, styleVersion, layerVisible, colorMode]);

  function startPulseAnimation(map: maplibregl.Map) {
    if (pulseAnimRef.current !== null) {
      cancelAnimationFrame(pulseAnimRef.current);
      pulseAnimRef.current = null;
    }
    const duration = 2000;
    const start = performance.now();

    function frame(now: number) {
      if (!map.getLayer(PULSE_LAYER_ID)) return;
      const elapsed = ((now - start) % duration) / duration;
      const scale = 1 + elapsed * 0.8;
      const opacity = 0.6 * (1 - elapsed);

      try {
        map.setPaintProperty(PULSE_LAYER_ID, "circle-radius", [
          "*",
          MAG_RADIUS_EXPR,
          scale,
        ] as maplibregl.ExpressionSpecification);
        map.setPaintProperty(PULSE_LAYER_ID, "circle-stroke-opacity", opacity);
      } catch {
        return;
      }

      pulseAnimRef.current = requestAnimationFrame(frame);
    }

    pulseAnimRef.current = requestAnimationFrame(frame);
  }

  // Heatmap toggle
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !map.getSource(SOURCE_ID)) return;

    try {
      if (showHeatmap && !map.getLayer(HEATMAP_LAYER_ID)) {
        const beforeLayer = getFirstSymbolLayerId(map);
        map.addLayer(
          {
            id: HEATMAP_LAYER_ID,
            type: "heatmap",
            source: SOURCE_ID,
            paint: {
              "heatmap-weight": [
                "interpolate",
                ["linear"],
                ["get", "mag"],
                0,
                0,
                8,
                1,
              ] as maplibregl.ExpressionSpecification,
              "heatmap-intensity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                0,
                1,
                9,
                3,
              ] as maplibregl.ExpressionSpecification,
              "heatmap-color": [
                "interpolate",
                ["linear"],
                ["heatmap-density"],
                0,
                "rgba(0,0,0,0)",
                0.2,
                "#ffffb2",
                0.4,
                "#fecc5c",
                0.6,
                "#fd8d3c",
                0.8,
                "#f03b20",
                1.0,
                "#bd0026",
              ] as maplibregl.ExpressionSpecification,
              "heatmap-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                0,
                4,
                9,
                30,
              ] as maplibregl.ExpressionSpecification,
              "heatmap-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                7,
                1,
                12,
                0,
              ] as maplibregl.ExpressionSpecification,
            },
          },
          beforeLayer,
        );
      } else if (!showHeatmap && map.getLayer(HEATMAP_LAYER_ID)) {
        map.removeLayer(HEATMAP_LAYER_ID);
      }
    } catch {
      // Layer or source may not be ready
    }
  }, [mapRef, mapReady, styleVersion, layerVisible, showHeatmap]);

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;

    const intervals: Record<string, number> = {
      hour: 60_000,
      day: 120_000,
      week: 300_000,
      month: 600_000,
    };

    const interval = setInterval(() => {
      fetchEarthquakes();
    }, intervals[timeRange] ?? 300_000);

    return () => clearInterval(interval);
  }, [layerVisible, timeRange, fetchEarthquakes]);

  // Click popup + cursor
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      const mag = Number(p.mag ?? 0);
      const depth = Number(p.depth ?? 0);
      const severity = magSeverityLabel(mag);
      const color = magColor(mag);
      const age = Number(p.ageMs ?? 0);
      const time = Number(p.time ?? 0);
      const place = escapeHtml(String(p.place || t("unknownLocation")));
      const felt = p.felt ? escapeHtml(String(p.felt)) : null;
      const alert = p.alert && p.alert !== "null" ? String(p.alert) : null;
      const tsunami = Number(p.tsunami ?? 0);
      const url = sanitizeUrl(String(p.url || ""));
      const dateStr = time
        ? new Date(time).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })
        : "";

      const alertBadge = alert
        ? `<span style="display:inline-block;background:${alert === "red" ? "#dc2626" : alert === "orange" ? "#f97316" : alert === "yellow" ? "#eab308" : "#22c55e"};color:${alert === "yellow" || alert === "green" ? "#000" : "#fff"};font-size:11px;padding:1px 6px;border-radius:3px;font-weight:600;text-transform:capitalize">${alert}</span>`
        : "";

      const details = [
        `<div style="font-size:12px;color:#666">${t("depth")}: ${depth.toFixed(1)} km (${depthLabel(depth)})</div>`,
        `<div style="font-size:12px;color:#666">${t("time")}: ${relativeTime(age)} (${dateStr})</div>`,
        felt
          ? `<div style="font-size:12px;color:#666">${t("felt")}: ${felt} ${t("reports")}</div>`
          : "",
        alertBadge
          ? `<div style="font-size:12px;color:#666;margin-top:2px">${t("alert")}: ${alertBadge}</div>`
          : "",
        tsunami
          ? `<div style="font-size:12px;color:#b91c1c;font-weight:600">${t("tsunamiWarning")}</div>`
          : "",
      ]
        .filter(Boolean)
        .join("");

      const html = `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:220px;padding-right:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="display:inline-flex;align-items:center;justify-content:center;background:${color};color:#fff;font-weight:700;font-size:18px;border-radius:6px;min-width:48px;height:36px;padding:0 8px">M ${mag.toFixed(1)}</span>
          <div>
            <div style="font-size:12px;color:#666">${severity}</div>
          </div>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">${place}</div>
        ${details}
        ${url ? `<div style="margin-top:6px;font-size:12px"><a href="${url}" target="_blank" rel="noreferrer" style="color:#1a73e8;text-decoration:none">${t("viewOnUSGS")} →</a></div>` : ""}
      </div>`;

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(CIRCLE_LAYER_ID)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [CIRCLE_LAYER_ID] });
      map.getCanvasContainer().style.cursor = features.length > 0 ? "pointer" : "";
    };

    map.on("click", CIRCLE_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(CIRCLE_LAYER_ID);

    return () => {
      map.off("click", CIRCLE_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
      INTERACTIVE_LAYER_IDS.delete(CIRCLE_LAYER_ID);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, t]);

  // Cleanup pulse animation on unmount
  useEffect(() => {
    return () => {
      if (pulseAnimRef.current !== null) {
        cancelAnimationFrame(pulseAnimRef.current);
        pulseAnimRef.current = null;
      }
    };
  }, []);

  return null;
}
