"use client";

import { escapeHtml, sanitizeUrl, useOverlayExclusion } from "@openmapx/core";
import { captureHazardFeatures } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { ALL_CATEGORIES, useNaturalEventStore } from "./store";

const SOURCE_ID = "openmapx-natural-events-source";
const CIRCLE_LAYER_ID = "openmapx-natural-events-circles";
const REFRESH_INTERVAL_MS = 900_000; // 15 minutes

export const CATEGORY_COLORS: Record<string, string> = {
  volcanoes: "#e53935",
  severeStorms: "#7b1fa2",
  floods: "#1565c0",
  landslides: "#6d4c41",
  seaLakeIce: "#4dd0e1",
  drought: "#f9a825",
  dustHaze: "#bcaaa4",
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

function naturalEventsGroup(activeCategories: Set<string>): MapLayerGroup {
  return {
    sources: { [SOURCE_ID]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION } },
    layers: [
      {
        id: CIRCLE_LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        filter: buildFilterExpr(activeCategories),
        slot: "overlay-points",
        order: 5,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 6, 5, 10, 10, 16, 14, 22],
          "circle-color": buildColorExpr(),
          "circle-opacity": 0.85,
          "circle-stroke-color": buildStrokeColorExpr(),
          "circle-stroke-width": buildStrokeWidthExpr(),
          "circle-stroke-opacity": 0.9,
        },
      },
    ],
  };
}

export function NaturalEventLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const t = useTranslations("naturalEvents");
  const layerVisible = useNaturalEventStore((s) => s.layerVisible);
  const resolveContributors = useContributorResolver();
  useRenderedMapAttributions("natural-events", [CIRCLE_LAYER_ID], layerVisible);
  const days = useNaturalEventStore((s) => s.days);
  const activeCategories = useNaturalEventStore((s) => s.activeCategories);
  const setLoading = useNaturalEventStore((s) => s.setLoading);
  const setEventCount = useNaturalEventStore((s) => s.setEventCount);
  const setLastUpdated = useNaturalEventStore((s) => s.setLastUpdated);
  const setUnavailable = useNaturalEventStore((s) => s.setUnavailable);

  useOverlayExclusion("natural-events", layerVisible);

  const popupRef = useRef<maplibregl.Popup | null>(null);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });

  const fetchEvents = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    let url = `${env.apiUrl}/api/integrations/overlay-natural-events/events?status=open&lang=${encodeURIComponent(locale)}`;
    if (days != null) {
      url += `&days=${days}`;
    }

    const request = beginRequest();
    setLoading(true);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent()) return;
      if (!res.ok) {
        setUnavailable(true);
        return;
      }
      const data = await res.json();
      if (!request.isCurrent()) return;
      setUnavailable(false);
      setEventCount(data.features?.length ?? 0);
      setLastUpdated(Date.now());

      const captured = captureHazardFeatures(data, resolveContributors, (feature) =>
        Array.isArray(feature.properties?.sources) ? feature.properties.sources : [],
      );
      publishGeoJson([{ sourceId: SOURCE_ID, data: captured }]);
    } catch {
      // A network failure leaves the layer as it was; an aborted request says nothing.
      if (request.isCurrent()) setUnavailable(true);
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [
    resolveContributors,
    beginRequest,
    env.apiUrl,
    locale,
    mapRef,
    days,
    publishGeoJson,
    setLoading,
    setEventCount,
    setLastUpdated,
    setUnavailable,
  ]);

  useMapLayerGroup(
    useMemo(
      () => (layerVisible ? naturalEventsGroup(activeCategories) : null),
      [layerVisible, activeCategories],
    ),
  );

  // Showing the overlay or changing the time window or language fetches immediately.
  useEffect(() => {
    if (!mapReady) return;
    if (layerVisible) void fetchEvents();
    else setEventCount(0);
  }, [mapReady, layerVisible, fetchEvents, setEventCount]);

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
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | null>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];

      const title = escapeHtml(String(p.title || "Unknown Event"));
      const catId = String(p.categoryId || "");
      const catTitle = escapeHtml(
        (ALL_CATEGORIES as readonly string[]).includes(catId)
          ? t(catId)
          : String(p.categoryTitle || catId),
      );
      const catColor = CATEGORY_COLORS[catId] || "#78909c";
      const date = p.date
        ? new Date(String(p.date)).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "";
      const magLabel = p.magnitudeLabel ? escapeHtml(String(p.magnitudeLabel)) : null;
      const sourceUrl = sanitizeUrl(String(p.sourceUrl ?? ""));
      const link = sanitizeUrl(String(p.link ?? ""));
      const alertLevel = p.alertLevel ? String(p.alertLevel) : null;
      const sourceId = String(p.source ?? "");
      const dataSource = escapeHtml(registry.findDataSource(sourceId)?.name ?? sourceId);

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
            ${sourceUrl ? `<a href="${sourceUrl}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${t("viewSource")}</a>` : ""}
            ${sourceUrl && link ? " · " : ""}
            ${link ? `<a href="${link}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${dataSource}</a>` : ""}
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
  }, [mapReady, styleVersion, mapRef, layerVisible, registry, t]);

  return null;
}
