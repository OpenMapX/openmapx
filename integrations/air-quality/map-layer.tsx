"use client";

import { escapeHtml, useOverlayExclusion } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useSourceAttributions } from "@/integration-api/overlay/useIntegrationAttribution";

import { useAirQualityStore } from "./store";
import { MONITOR_MIN_ZOOM, MONITOR_SOURCE_ID, useMonitorStations } from "./use-monitor-stations";

export const MONITOR_LAYER_ID = "openmapx-air-quality-monitor-circles";

export const CIVIDIS_CONCENTRATION_EXPRESSION = [
  "interpolate",
  ["linear"],
  ["get", "value"],
  0,
  "#00204c",
  10,
  "#193f63",
  25,
  "#4f5f6d",
  50,
  "#8d8567",
  75,
  "#c8ad53",
  100,
  "#fee838",
] as const;

type Freshness = "fresh" | "stale" | "unknown";
type Quality = "regulatory-certified" | "quality-assured" | "preliminary" | "estimated" | "unknown";
type StationClass = "reference" | "regulatory" | "indicative" | "low-cost" | "unknown";

export interface MonitorPopupLabels {
  concentration: string;
  observed: string;
  interval: string;
  freshness: string;
  quality: string;
  stationClass: string;
  completeness: string;
  provider: string;
  sources: string;
  owner: string;
  mobile: string;
  fixed: string;
  estimated: string;
  gapFilled: string;
  unknown: string;
  freshnessValues: Record<Freshness, string>;
  qualityValues: Record<Quality, string>;
  stationClassValues: Record<StationClass, string>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function sourceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // MapLibre may expose a simple comma-separated string for array properties.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pollutantSymbol(value: string): string {
  switch (value) {
    case "pm25":
      return "PM₂.₅";
    case "pm10":
      return "PM₁₀";
    case "o3":
      return "O₃";
    case "no2":
      return "NO₂";
    case "so2":
      return "SO₂";
    case "co":
      return "CO";
    case "nh3":
      return "NH₃";
    case "no":
      return "NO";
    default:
      return "?";
  }
}

function unitText(value: string): string {
  switch (value) {
    case "ug/m3":
      return "µg/m³";
    case "mg/m3":
      return "mg/m³";
    case "ppb":
    case "ppm":
      return value;
    default:
      return "—";
  }
}

function knownValue<T extends string>(value: unknown, values: Record<T, string>, fallback: string) {
  return typeof value === "string" && value in values ? values[value as T] : fallback;
}

function formatInstant(value: unknown, locale: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

function row(label: string, value: string): string {
  return `<div style="font-size:11px;color:#555;margin-top:3px"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`;
}

export function buildMonitorPopupHtml(
  properties: Record<string, unknown>,
  labels: MonitorPopupLabels,
  locale: string,
): string {
  const numericValue = Number(properties.value);
  const value = Number.isFinite(numericValue)
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(numericValue)
    : labels.unknown;
  const completeness = Number(properties.completenessPercent);
  const evidenceFlags = [
    booleanValue(properties.estimated) ? labels.estimated : "",
    booleanValue(properties.gapFilled) ? labels.gapFilled : "",
  ].filter(Boolean);
  const sources = sourceIds(properties.sourceIds);
  const stationClass = knownValue(
    properties.stationClass,
    labels.stationClassValues,
    labels.unknown,
  );
  const mobile = booleanValue(properties.mobile) ? labels.mobile : labels.fixed;
  const interval = `${formatInstant(properties.intervalStart, locale, labels.unknown)} – ${formatInstant(
    properties.intervalEnd,
    locale,
    labels.unknown,
  )}`;

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:220px;max-width:280px">
    <div style="font-size:14px;font-weight:700;margin-bottom:6px">${escapeHtml(stringValue(properties.name) || labels.unknown)}</div>
    <div style="font-size:20px;font-weight:700">${escapeHtml(value)} ${escapeHtml(unitText(stringValue(properties.unit)))}</div>
    <div style="font-size:12px;color:#555">${escapeHtml(pollutantSymbol(stringValue(properties.pollutant)))} · ${escapeHtml(labels.concentration)}</div>
    ${row(labels.observed, formatInstant(properties.observedAt, locale, labels.unknown))}
    ${row(labels.interval, interval)}
    ${row(labels.freshness, knownValue(properties.freshness, labels.freshnessValues, labels.unknown))}
    ${row(labels.quality, knownValue(properties.qualityStatus, labels.qualityValues, labels.unknown))}
    ${row(labels.stationClass, `${stationClass} · ${mobile}`)}
    ${row(labels.completeness, Number.isFinite(completeness) ? `${completeness}%` : labels.unknown)}
    ${evidenceFlags.length > 0 ? row(labels.quality, evidenceFlags.join(" · ")) : ""}
    ${row(labels.provider, stringValue(properties.providerId) || labels.unknown)}
    ${row(labels.sources, sources.join(", ") || labels.unknown)}
    ${row(labels.owner, stringValue(properties.owner) || labels.unknown)}
  </div>`;
}

function popupLabels(t: ReturnType<typeof useTranslations>): MonitorPopupLabels {
  return {
    concentration: t("popup.concentration"),
    observed: t("popup.observed"),
    interval: t("popup.interval"),
    freshness: t("popup.freshness"),
    quality: t("popup.quality"),
    stationClass: t("popup.stationClass"),
    completeness: t("popup.completeness"),
    provider: t("popup.provider"),
    sources: t("popup.sources"),
    owner: t("popup.owner"),
    mobile: t("popup.mobile"),
    fixed: t("popup.fixed"),
    estimated: t("popup.estimated"),
    gapFilled: t("popup.gapFilled"),
    unknown: t("popup.unknown"),
    freshnessValues: {
      fresh: t("freshness.fresh"),
      stale: t("freshness.stale"),
      unknown: t("freshness.unknown"),
    },
    qualityValues: {
      "regulatory-certified": t("quality.regulatoryCertified"),
      "quality-assured": t("quality.qualityAssured"),
      preliminary: t("quality.preliminary"),
      estimated: t("quality.estimated"),
      unknown: t("quality.unknown"),
    },
    stationClassValues: {
      reference: t("stationClass.reference"),
      regulatory: t("stationClass.regulatory"),
      indicative: t("stationClass.indicative"),
      "low-cost": t("stationClass.lowCost"),
      unknown: t("stationClass.unknown"),
    },
  };
}

export function AirQualityLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const t = useTranslations("airQualityMap");
  const locale = useLocale();
  const layerVisible = useAirQualityStore((state) => state.layerVisible);
  const mode = useAirQualityStore((state) => state.mode);
  const activeSourceIds = useAirQualityStore((state) => state.activeSourceIds);
  const monitorsActive = layerVisible && mode.kind === "monitors";
  const labels = useMemo(() => popupLabels(t), [t]);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  useMonitorStations();
  useOverlayExclusion("air-quality", layerVisible);
  useSourceAttributions("air-quality", monitorsActive ? activeSourceIds : []);

  const group = useMemo<MapLayerGroup | null>(
    () =>
      monitorsActive
        ? {
            sources: {
              [MONITOR_SOURCE_ID]: {
                type: "geojson" as const,
                data: { type: "FeatureCollection" as const, features: [] },
              },
            },
            layers: [
              {
                id: MONITOR_LAYER_ID,
                type: "circle" as const,
                source: MONITOR_SOURCE_ID,
                minzoom: MONITOR_MIN_ZOOM,
                slot: "overlay-points" as const,
                order: 0,
                paint: {
                  "circle-radius": [
                    "interpolate",
                    ["linear"],
                    ["min", ["get", "value"], 100],
                    0,
                    5,
                    100,
                    14,
                  ],
                  "circle-color":
                    CIVIDIS_CONCENTRATION_EXPRESSION as unknown as maplibregl.ExpressionSpecification,
                  "circle-opacity": [
                    "match",
                    ["get", "freshness"],
                    "fresh",
                    0.82,
                    "stale",
                    0.42,
                    0.6,
                  ],
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-opacity": 0.9,
                  "circle-stroke-width": [
                    "match",
                    ["get", "stationClass"],
                    "reference",
                    2.5,
                    "regulatory",
                    2,
                    "indicative",
                    1.5,
                    "low-cost",
                    0.75,
                    1,
                  ],
                },
              },
            ],
          }
        : null,
    [monitorsActive],
  );
  useMapLayerGroup(group);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !monitorsActive || !map.getLayer(MONITOR_LAYER_ID)) return;
    const canvas = map.getCanvasContainer();

    const openFeature = (feature: maplibregl.MapGeoJSONFeature) => {
      if (feature.geometry.type !== "Point") return;
      const coordinates = feature.geometry.coordinates as [number, number];
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(coordinates)
        .setHTML(
          buildMonitorPopupHtml(feature.properties as Record<string, unknown>, labels, locale),
        )
        .addTo(map);
    };
    const onClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (feature) openFeature(feature);
    };
    const onMouseMove = (event: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(event.point, { layers: [MONITOR_LAYER_ID] });
      canvas.style.cursor = features.length > 0 ? "pointer" : "";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const features = map.queryRenderedFeatures(map.project(map.getCenter()), {
        layers: [MONITOR_LAYER_ID],
      });
      const feature = features[0];
      if (!feature) return;
      event.preventDefault();
      openFeature(feature);
    };

    map.on("click", MONITOR_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);
    canvas.addEventListener("keydown", onKeyDown);
    INTERACTIVE_LAYER_IDS.add(MONITOR_LAYER_ID);

    return () => {
      map.off("click", MONITOR_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.style.cursor = "";
      popupRef.current?.remove();
      popupRef.current = null;
      INTERACTIVE_LAYER_IDS.delete(MONITOR_LAYER_ID);
    };
  }, [labels, locale, mapReady, mapRef, monitorsActive, styleVersion]);

  return null;
}

export default AirQualityLayer;
