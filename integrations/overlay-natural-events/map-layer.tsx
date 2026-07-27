"use client";

import { escapeHtml, useOverlayExclusion } from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useNaturalEventStore } from "./store";

const SOURCE_ID = "openmapx-natural-events-source";
const CIRCLE_LAYER_ID = "openmapx-natural-events-circles";
const REFRESH_INTERVAL_MS = 900_000; // 15 minutes

export const CATEGORY_COLORS: Record<string, string> = {
  volcanoes: "#e53935",
  severeStorms: "#7b1fa2",
  floods: "#1565c0",
  landslides: "#6d4c41",
  snow: "#90caf9",
  tempExtremes: "#ff6f00",
  dustHaze: "#bcaaa4",
  seaLakeIce: "#4dd0e1",
  waterColor: "#00897b",
  drought: "#f9a825",
  manmade: "#546e7a",
};

const ALERT_STROKE_COLORS: Record<string, string> = {
  red: "#d50000",
  orange: "#ff6d00",
};

function buildColorExpr(): maplibregl.ExpressionSpecification {
  // Accumulate into `unknown[]` and cast once, the shape the other overlays
  // use: a match expression built from a variable number of cases can't be
  // spread into the fixed tuple `ExpressionSpecification` describes.
  const expr: unknown[] = ["match", ["get", "categoryId"]];
  for (const [id, color] of Object.entries(CATEGORY_COLORS)) {
    expr.push(id, color);
  }
  expr.push("#78909c");
  return expr as maplibregl.ExpressionSpecification;
}

function buildStrokeColorExpr(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "alertLevel"],
    "red",
    ALERT_STROKE_COLORS.red,
    "orange",
    ALERT_STROKE_COLORS.orange,
    "#ffffff",
  ] as maplibregl.ExpressionSpecification;
}

function buildStrokeWidthExpr(): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    2,
    [
      "case",
      ["==", ["get", "alertLevel"], "red"],
      2.5,
      ["==", ["get", "alertLevel"], "orange"],
      2,
      1,
    ],
    8,
    [
      "case",
      ["==", ["get", "alertLevel"], "red"],
      4,
      ["==", ["get", "alertLevel"], "orange"],
      3,
      2,
    ],
  ] as maplibregl.ExpressionSpecification;
}

function buildFilterExpr(active: Set<string>): maplibregl.ExpressionSpecification {
  return [
    "in",
    ["get", "categoryId"],
    ["literal", [...active]],
  ] as maplibregl.ExpressionSpecification;
}

export function NaturalEventLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const t = useTranslations("naturalEvents");
  const layerVisible = useNaturalEventStore((s) => s.layerVisible);
  useIntegrationAttribution("overlay-natural-events", layerVisible);
  const days = useNaturalEventStore((s) => s.days);
  const activeCategories = useNaturalEventStore((s) => s.activeCategories);
  const setLoading = useNaturalEventStore((s) => s.setLoading);
  const setEventCount = useNaturalEventStore((s) => s.setEventCount);
  const setLastUpdated = useNaturalEventStore((s) => s.setLastUpdated);

  useOverlayExclusion("natural-events", layerVisible);
  useLayerReanchor(CIRCLE_LAYER_ID, layerVisible);

  const popupRef = useRef<maplibregl.Popup | null>(null);
  const fetchedRef = useRef(false);
  const prevDaysRef = useRef(days);

  const fetchEvents = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    let url = `${env.apiUrl}/api/integrations/overlay-natural-events/events?status=open`;
    if (days != null) {
      url += `&days=${days}`;
    }

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setEventCount(data.features?.length ?? 0);
      setLastUpdated(Date.now());

      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [env.apiUrl, mapRef, days, setLoading, setEventCount, setLastUpdated]);

  // Refetch when days changes
  useEffect(() => {
    if (prevDaysRef.current !== days && layerVisible) {
      prevDaysRef.current = days;
      fetchedRef.current = false;
    }
  }, [days, layerVisible]);

  // Main layer lifecycle
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // ignore
        }
        popupRef.current?.remove();
        fetchedRef.current = false;
        setEventCount(0);
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

      if (!map.getLayer(CIRCLE_LAYER_ID)) {
        map.addLayer(
          {
            id: CIRCLE_LAYER_ID,
            type: "circle",
            source: SOURCE_ID,
            filter: buildFilterExpr(activeCategories),
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 6, 5, 10, 10, 16, 14, 22],
              "circle-color": buildColorExpr(),
              "circle-opacity": 0.85,
              "circle-stroke-color": buildStrokeColorExpr(),
              "circle-stroke-width": buildStrokeWidthExpr(),
              "circle-stroke-opacity": 0.9,
            },
          },
          getFirstSymbolLayerId(map),
        );
      }

      if (!fetchedRef.current) {
        fetchedRef.current = true;
        fetchEvents();
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
  }, [mapReady, styleVersion, mapRef, layerVisible, activeCategories, fetchEvents, setEventCount]);

  // Update filter when activeCategories changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    if (map.getLayer(CIRCLE_LAYER_ID)) {
      map.setFilter(CIRCLE_LAYER_ID, buildFilterExpr(activeCategories));
    }
  }, [mapRef, mapReady, layerVisible, activeCategories]);

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;
    const interval = setInterval(() => {
      fetchEvents();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [layerVisible, fetchEvents]);

  // Click popup
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | null>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];

      const title = escapeHtml(String(p.title || "Unknown Event"));
      const catId = String(p.categoryId || "");
      const catTitle = escapeHtml(String(p.categoryTitle || catId));
      const catColor = CATEGORY_COLORS[catId] || "#78909c";
      const date = p.date
        ? new Date(String(p.date)).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "";
      const magLabel = p.magnitudeLabel ? escapeHtml(String(p.magnitudeLabel)) : null;
      const sourceUrl = p.sourceUrl ? String(p.sourceUrl) : null;
      const link = p.link ? String(p.link) : null;
      const alertLevel = p.alertLevel ? String(p.alertLevel) : null;
      const dataSource = p.source === "gdacs" ? "GDACS" : "NASA EONET";

      const alertBadge =
        alertLevel && alertLevel !== "green"
          ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;color:#fff;background:${alertLevel === "red" ? "#d50000" : "#ff6d00"};margin-left:4px">${alertLevel === "red" ? t("alertRed") : t("alertOrange")}</span>`
          : "";

      const html = `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;max-width:280px">
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">${title}</div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px">
            <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;color:#fff;background:${catColor}">
              ${catTitle}
            </span>
            ${alertBadge}
          </div>
          ${date ? `<div style="font-size:12px;color:#666;margin-bottom:4px">${date}</div>` : ""}
          ${magLabel ? `<div style="font-size:12px;margin-bottom:4px"><span style="color:#666">${t("magnitude")}:</span> <strong>${magLabel}</strong></div>` : ""}
          <div style="font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:4px;margin-top:4px">
            ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${t("viewSource")}</a>` : ""}
            ${sourceUrl && link ? " · " : ""}
            ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${dataSource}</a>` : ""}
            ${!link && !sourceUrl ? dataSource : ""}
          </div>
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
  }, [mapReady, styleVersion, mapRef, layerVisible, t]);

  return null;
}
