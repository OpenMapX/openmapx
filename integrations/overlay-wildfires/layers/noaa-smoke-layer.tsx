"use client";

import { captureHazardFeatures } from "@openmapx/integration-framework";
import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import type { WildfirePopupController } from "../popup-controller";
import {
  buildNoaaSmokePopupModel,
  NOAA_SMOKE_DENSITY_STYLE,
  NOAA_SMOKE_STYLE,
  type WildfirePopupTranslate,
} from "../presentation";
import { isSourceId } from "../source-id";
import { useWildfireStore } from "../store";
import type { NoaaSmokeProperties, WildfireFeatureCollection } from "../types";
import { type FillPaint, type LinePaint, usePolygonLayerLifecycle } from "./polygon-layer";

export const NOAA_SMOKE_SOURCE = "openmapx-wildfires-noaa-smoke-source";
export const NOAA_SMOKE_FILL = "openmapx-wildfires-noaa-smoke-fill";
export const NOAA_SMOKE_LINE = "openmapx-wildfires-noaa-smoke-line";

const REFRESH_MS = 600_000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isCanonicalTimestamp(value);
}

function isPosition(value: unknown): value is GeoJSON.Position {
  if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) return false;
  const [longitude, latitude] = value;
  return (
    typeof longitude === "number" &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === "number" &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function positionsEqual(first: GeoJSON.Position, last: GeoJSON.Position): boolean {
  return (
    first.length === last.length && first.every((coordinate, index) => coordinate === last[index])
  );
}

function isRing(value: unknown): value is GeoJSON.Position[] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(isPosition) &&
    positionsEqual(value[0] as GeoJSON.Position, value.at(-1) as GeoJSON.Position)
  );
}

function isPolygonCoordinates(value: unknown): value is GeoJSON.Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isRing);
}

function isSmokeGeometry(value: unknown): value is GeoJSON.Polygon | GeoJSON.MultiPolygon {
  if (!isRecord(value)) return false;
  if (value.type === "Polygon") return isPolygonCoordinates(value.coordinates);
  return (
    value.type === "MultiPolygon" &&
    Array.isArray(value.coordinates) &&
    value.coordinates.length > 0 &&
    value.coordinates.every(isPolygonCoordinates)
  );
}

function isNoaaSmokeProperties(value: unknown): value is NoaaSmokeProperties {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.startsWith("noaa-hms:") &&
    value.id.length > "noaa-hms:".length &&
    value.kind === "observed-smoke" &&
    isSourceId(value.provider) &&
    (value.density === "light" || value.density === "medium" || value.density === "heavy") &&
    (value.satellite === undefined || typeof value.satellite === "string") &&
    isOptionalTimestamp(value.startedAt) &&
    isOptionalTimestamp(value.endedAt)
  );
}

function isNoaaSmokeFeature(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "Feature" || !isNoaaSmokeProperties(value.properties)) {
    return false;
  }
  return value.id === value.properties.id && isSmokeGeometry(value.geometry);
}

/** Validates the full cached NOAA provider contract before data reaches MapLibre. */
export function isNoaaSmokeFeatureCollection(value: unknown): value is WildfireFeatureCollection {
  if (!isRecord(value)) return false;
  return (
    value.type === "FeatureCollection" &&
    value.source === "noaa-hms" &&
    isCanonicalTimestamp(value.fetchedAt) &&
    typeof value.stale === "boolean" &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.sources) &&
    value.sources.every(isSourceId) &&
    Array.isArray(value.features) &&
    value.features.every(isNoaaSmokeFeature)
  );
}

const FILL_OPACITY: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "density"],
  "light",
  NOAA_SMOKE_DENSITY_STYLE.light.fillOpacity,
  "medium",
  NOAA_SMOKE_DENSITY_STYLE.medium.fillOpacity,
  "heavy",
  NOAA_SMOKE_DENSITY_STYLE.heavy.fillOpacity,
  NOAA_SMOKE_DENSITY_STYLE.light.fillOpacity,
];

const FILL_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "density"],
  "light",
  NOAA_SMOKE_DENSITY_STYLE.light.fillColor,
  "medium",
  NOAA_SMOKE_DENSITY_STYLE.medium.fillColor,
  "heavy",
  NOAA_SMOKE_DENSITY_STYLE.heavy.fillColor,
  NOAA_SMOKE_DENSITY_STYLE.medium.fillColor,
];

const FILL_PAINT: FillPaint = { "fill-color": FILL_COLOR, "fill-opacity": FILL_OPACITY };

const LINE_PAINT: LinePaint = {
  "line-color": NOAA_SMOKE_STYLE.lineColor,
  "line-opacity": NOAA_SMOKE_STYLE.lineOpacity,
  "line-width": NOAA_SMOKE_STYLE.lineWidth,
};

export interface NoaaSmokeLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

export function NoaaSmokeLayer({ active, popupController }: NoaaSmokeLayerProps) {
  const mapContext = useMap();
  const env = useEnv();
  const locale = useLocale();
  const translate = useTranslations("wildfires") as WildfirePopupTranslate;
  const setSourceStatus = useWildfireStore((state) => state.setSourceStatus);
  const resetSourceStatus = useWildfireStore((state) => state.resetSourceStatus);
  const resolveContributors = useContributorResolver();
  useRenderedMapAttributions("wildfires-smoke", [NOAA_SMOKE_FILL, NOAA_SMOKE_LINE], active);
  const bridge = useGeoJsonSourceDataBridge({
    mapRef: mapContext.mapRef,
    mapReady: mapContext.mapReady,
    styleVersion: mapContext.styleVersion,
    visible: active,
  });

  const fetchSmoke = useCallback(async () => {
    if (!active || !mapContext.mapReady || !mapContext.mapRef.current) return;
    const request = bridge.beginRequest();
    setSourceStatus("noaa-hms", { loading: true, error: null });
    try {
      const result = await fetch(`${env.apiUrl}/api/integrations/overlay-wildfires/smoke/noaa`, {
        signal: request.signal,
      });
      if (!request.isCurrent()) return;
      if (!result.ok) throw new Error(`NOAA smoke source returned ${result.status}`);
      const data: unknown = await result.json();
      if (!request.isCurrent()) return;
      if (!isNoaaSmokeFeatureCollection(data)) {
        throw new Error("Invalid NOAA smoke FeatureCollection");
      }
      const captured = captureHazardFeatures(data, resolveContributors, (feature) =>
        Array.isArray(feature.properties?.sources)
          ? feature.properties.sources
          : typeof feature.properties?.provider === "string"
            ? [feature.properties.provider]
            : [],
      );
      bridge.publish([{ sourceId: NOAA_SMOKE_SOURCE, data: captured }]);
      setSourceStatus("noaa-hms", {
        loading: false,
        fetchedAt: Date.parse(data.fetchedAt),
        stale: data.stale,
        truncated: data.truncated,
        error: null,
        featureCount: data.features.length,
        sources: data.sources,
      });
    } catch {
      if (!request.isCurrent()) return;
      setSourceStatus("noaa-hms", { loading: false, error: "unavailable" });
    }
  }, [
    active,
    bridge.beginRequest,
    bridge.publish,
    env.apiUrl,
    mapContext.mapReady,
    mapContext.mapRef,
    setSourceStatus,
    resolveContributors,
  ]);

  useEffect(() => {
    if (!active) {
      resetSourceStatus("noaa-hms");
      return;
    }
    void fetchSmoke();
    const refresh = setInterval(() => void fetchSmoke(), REFRESH_MS);
    return () => {
      clearInterval(refresh);
      resetSourceStatus("noaa-hms");
    };
  }, [active, fetchSmoke, resetSourceStatus]);

  const popupModel = useCallback(
    (properties: Record<string, unknown>) =>
      isNoaaSmokeProperties(properties) ? buildNoaaSmokePopupModel(properties, locale) : null,
    [locale],
  );
  usePolygonLayerLifecycle({
    active,
    sourceId: NOAA_SMOKE_SOURCE,
    fillId: NOAA_SMOKE_FILL,
    lineId: NOAA_SMOKE_LINE,
    fillOrder: 3,
    lineOrder: 4,
    fillPaint: FILL_PAINT,
    linePaint: LINE_PAINT,
    popupController,
    popupModel,
    translate,
  });

  return null;
}
