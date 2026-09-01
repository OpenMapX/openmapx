"use client";

import { escapeHtml, relativeTime } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { syncHeatmapLayer } from "@/integration-api/map/heatmapLayer";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { isFirmsFeatureCollection, readFirmsResponseMetadata } from "../firms-response";
import type { WildfirePopupController, WildfirePopupLease } from "../popup-controller";
import { useWildfireStore } from "../store";

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

export interface HotspotLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

function confidenceLabel(conf: string): string {
  if (conf === "high" || conf === "h") return "High";
  if (conf === "nominal" || conf === "n") return "Nominal";
  const num = Number.parseInt(conf, 10);
  if (!Number.isNaN(num)) return `${num}%`;
  return escapeHtml(conf);
}

export function HotspotLayer({ active, popupController }: HotspotLayerProps) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const dayRange = useWildfireStore((s) => s.dayRange);
  const source = useWildfireStore((s) => s.source);
  const showHeatmap = useWildfireStore((s) => s.showHeatmap);
  const setLoading = useWildfireStore((s) => s.setLoading);
  const setLastUpdated = useWildfireStore((s) => s.setLastUpdated);
  const setSourceStatus = useWildfireStore((s) => s.setSourceStatus);
  const resetSourceStatus = useWildfireStore((s) => s.resetSourceStatus);
  const t = useTranslations("wildfires");
  const popupLease = useRef<WildfirePopupLease>({});
  const fetchedRef = useRef(false);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: active,
  });

  const fetchWildfires = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const url = `${apiUrl}/api/integrations/overlay-wildfires/wildfires?dayRange=${dayRange}&source=${source}`;

    const request = beginRequest();
    setLoading(true);
    setSourceStatus("firms", { loading: true, error: null });
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent()) return;
      if (!res.ok) throw new Error(`FIRMS source returned ${res.status}`);
      const data: unknown = await res.json();
      if (!request.isCurrent()) return;
      if (!isFirmsFeatureCollection(data, source)) {
        throw new Error("Invalid FIRMS FeatureCollection");
      }

      publishGeoJson([{ sourceId: SOURCE_ID, data }]);
      const { fetchedAt, stale } = readFirmsResponseMetadata(res.headers, Date.now());
      setLastUpdated(fetchedAt);
      setSourceStatus("firms", {
        loading: false,
        fetchedAt,
        stale,
        truncated: false,
        error: null,
        featureCount: data.features.length,
      });
    } catch {
      if (request.isCurrent()) {
        setSourceStatus("firms", { loading: false, error: "unavailable" });
      }
    } finally {
      if (request.isLatest()) {
        setLoading(false);
        setSourceStatus("firms", { loading: false });
      }
    }
  }, [
    beginRequest,
    apiUrl,
    mapRef,
    dayRange,
    source,
    publishGeoJson,
    setLoading,
    setLastUpdated,
    setSourceStatus,
  ]);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      resetSourceStatus("firms");
    }
    return () => {
      setLoading(false);
      resetSourceStatus("firms");
    };
  }, [active, resetSourceStatus, setLoading]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!active) {
        try {
          if (map.getLayer(HEATMAP_LAYER_ID)) map.removeLayer(HEATMAP_LAYER_ID);
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        unregisterLayerSlot(HEATMAP_LAYER_ID);
        unregisterLayerSlot(CIRCLE_LAYER_ID);
        popupController.close(popupLease.current);
        fetchedRef.current = false;
        return;
      }

      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }

        if (!map.getLayer(CIRCLE_LAYER_ID)) {
          addLayerInSlot(
            map,
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
            "overlay-points",
            4,
          );
        }

        if (!fetchedRef.current) {
          fetchedRef.current = true;
          void fetchWildfires();
        }
      } catch {
        // Style not ready — styledata will retry
      }
    };

    if (!active) {
      syncLayers();
      return;
    }

    fetchedRef.current = false;
    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
      popupController.close(popupLease.current);
    };
  }, [mapReady, mapRef, styleVersion, active, fetchWildfires, popupController]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    syncHeatmapLayer(map, {
      enabled: showHeatmap,
      layerId: HEATMAP_LAYER_ID,
      sourceId: SOURCE_ID,
      weightProperty: "frp",
      weightMax: 1000,
      order: 0,
    });
  }, [mapRef, mapReady, styleVersion, active, showHeatmap]);

  useEffect(() => {
    if (!active) return;

    const intervals: Record<number, number> = {
      1: 300_000,
      2: 600_000,
      3: 900_000,
    };

    const interval = setInterval(() => {
      void fetchWildfires();
    }, intervals[dayRange] ?? 300_000);

    return () => clearInterval(interval);
  }, [active, dayRange, fetchWildfires]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      const frp = Number(p.frp ?? 0);
      const brightness = Number(p.brightness ?? 0);
      const confidence = String(p.confidence ?? "");
      const satellite = escapeHtml(String(p.satellite ?? ""));
      const ageMs = Number(p.ageMs ?? 0);
      const dayNight = String(p.dayNight ?? "");
      const acqDate = escapeHtml(String(p.acqDate ?? ""));
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
      </div>`;

      popupController.open(
        popupLease.current,
        new maplibregl.Popup({
          closeButton: true,
          maxWidth: "280px",
          className: "omx-popup",
        })
          .setLngLat(coords)
          .setHTML(html)
          .addTo(map),
      );
    };

    const onMouseEnter = () => {
      map.getCanvasContainer().style.cursor = "pointer";
    };

    const onMouseLeave = () => {
      map.getCanvasContainer().style.cursor = "";
    };

    map.on("click", CIRCLE_LAYER_ID, onClick);
    map.on("mouseenter", CIRCLE_LAYER_ID, onMouseEnter);
    map.on("mouseleave", CIRCLE_LAYER_ID, onMouseLeave);
    INTERACTIVE_LAYER_IDS.add(CIRCLE_LAYER_ID);

    return () => {
      map.off("click", CIRCLE_LAYER_ID, onClick);
      map.off("mouseenter", CIRCLE_LAYER_ID, onMouseEnter);
      map.off("mouseleave", CIRCLE_LAYER_ID, onMouseLeave);
      map.getCanvasContainer().style.cursor = "";
      INTERACTIVE_LAYER_IDS.delete(CIRCLE_LAYER_ID);
    };
  }, [mapReady, mapRef, styleVersion, active, popupController, t]);

  return null;
}
