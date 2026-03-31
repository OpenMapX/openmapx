"use client";

import { relativeTime, useOverlayExclusion, useWildfireStore } from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const HEATMAP_LAYER_ID = "openmapx-wildfires-heatmap";

/** Circle radius scales with FRP (Fire Radiative Power in MW). */
const FRP_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "frp"],
  0,
  3,
  10,
  5,
  50,
  8,
  200,
  13,
  500,
  18,
  1000,
  24,
];

/** Zoom-scaled circle radius. */
const CIRCLE_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  2,
  ["*", FRP_RADIUS_EXPR, 0.5],
  5,
  ["*", FRP_RADIUS_EXPR, 0.8],
  8,
  FRP_RADIUS_EXPR,
  12,
  ["*", FRP_RADIUS_EXPR, 1.6],
];

/** Color by recency: recent = bright red, older = dim orange/yellow. */
const RECENCY_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "ageMs"],
  0,
  "#ef4444",
  3_600_000,
  "#f97316",
  21_600_000,
  "#fb923c",
  43_200_000,
  "#fbbf24",
  86_400_000,
  "#fcd34d",
  172_800_000,
  "#fde68a",
];

function confidenceLabel(conf: string): string {
  if (conf === "high" || conf === "h") return "High";
  if (conf === "nominal" || conf === "n") return "Nominal";
  const num = Number.parseInt(conf, 10);
  if (!Number.isNaN(num)) return `${num}%`;
  return conf;
}

export function WildfireLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const dayRange = useWildfireStore((s) => s.dayRange);
  const source = useWildfireStore((s) => s.source);
  const showHeatmap = useWildfireStore((s) => s.showHeatmap);
  const setLoading = useWildfireStore((s) => s.setLoading);
  const setLastUpdated = useWildfireStore((s) => s.setLastUpdated);
  useOverlayExclusion("wildfires", layerVisible);
  useLayerReanchor([CIRCLE_LAYER_ID, HEATMAP_LAYER_ID], layerVisible);
  const t = useTranslations("wildfires");
  const fetchedRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const fetchWildfires = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const { apiUrl } = env;
    const url = `${apiUrl}/api/integrations/overlay-wildfires/wildfires?dayRange=${dayRange}&source=${source}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        setLastUpdated(Date.now());
      }
    } catch {
      // Silent fetch failure
    } finally {
      setLoading(false);
    }
  }, [env, mapRef, dayRange, source, setLoading, setLastUpdated]);

  // Layer management
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(HEATMAP_LAYER_ID)) map.removeLayer(HEATMAP_LAYER_ID);
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        popupRef.current?.remove();
        fetchedRef.current = false;
        return;
      }

      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            attribution:
              '© <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank">NASA FIRMS</a> (<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank">CC0</a>)',
          });
        }

        const beforeLayer = getFirstSymbolLayerId(map);

        if (!map.getLayer(CIRCLE_LAYER_ID)) {
          map.addLayer(
            {
              id: CIRCLE_LAYER_ID,
              type: "circle",
              source: SOURCE_ID,
              paint: {
                "circle-radius": CIRCLE_RADIUS_EXPR,
                "circle-color": RECENCY_COLOR_EXPR,
                "circle-opacity": 0.8,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 0.8,
              },
            },
            beforeLayer,
          );
        }

        if (!fetchedRef.current) {
          fetchedRef.current = true;
          fetchWildfires();
        }
      } catch {
        // Style not ready — styledata will retry
      }
    };

    if (!layerVisible) {
      syncLayers();
      return;
    }

    fetchedRef.current = false;
    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchWildfires]);

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
                ["get", "frp"],
                0,
                0,
                1000,
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

    const intervals: Record<number, number> = {
      1: 300_000,
      2: 600_000,
      3: 900_000,
    };

    const interval = setInterval(() => {
      fetchWildfires();
    }, intervals[dayRange] ?? 300_000);

    return () => clearInterval(interval);
  }, [layerVisible, dayRange, fetchWildfires]);

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
      const frp = Number(p.frp ?? 0);
      const brightness = Number(p.brightness ?? 0);
      const confidence = String(p.confidence ?? "");
      const satellite = String(p.satellite ?? "");
      const ageMs = Number(p.ageMs ?? 0);
      const dayNight = String(p.dayNight ?? "");
      const acqDate = String(p.acqDate ?? "");
      const acqTime = String(p.acqTime ?? "");
      const timeStr = acqTime.padStart(4, "0");
      const formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)} UTC`;

      const frpColor =
        frp >= 500 ? "#dc2626" : frp >= 100 ? "#f97316" : frp >= 10 ? "#eab308" : "#94a3b8";

      const html = `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;padding-right:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="display:inline-flex;align-items:center;justify-content:center;background:${frpColor};color:#fff;font-weight:700;font-size:13px;border-radius:6px;min-width:48px;height:32px;padding:0 8px;white-space:nowrap">${frp.toFixed(1)} MW</span>
          <div style="font-size:12px;color:#666">${t("fireRadiativePower")}</div>
        </div>
        <div style="font-size:12px;color:#666">${t("brightness")}: ${brightness.toFixed(1)} K</div>
        <div style="font-size:12px;color:#666">${t("confidence")}: ${confidenceLabel(confidence)}</div>
        <div style="font-size:12px;color:#666">${t("satellite")}: ${satellite}</div>
        <div style="font-size:12px;color:#666">${t("detected")}: ${relativeTime(ageMs)} (${acqDate} ${formattedTime})</div>
        <div style="font-size:12px;color:#666">${t("observation")}: ${dayNight === "D" ? t("daytime") : t("nighttime")}</div>
        <div style="font-size:12px;color:#666">${t("coordinates")}: ${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}</div>
        <div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:5px;margin-top:5px">${t("data")}: <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">NASA FIRMS</a> (LANCE) · <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">CC0</a></div>
      </div>`;

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "280px",
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

    return () => {
      map.off("click", CIRCLE_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, t]);

  return null;
}
