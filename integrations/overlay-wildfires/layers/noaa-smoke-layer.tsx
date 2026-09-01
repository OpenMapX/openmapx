"use client";

import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import type { WildfirePopupController, WildfirePopupLease } from "../popup-controller";
import {
  buildNoaaSmokePopupModel,
  renderWildfirePopupModel as buildPopupCard,
  NOAA_SMOKE_DENSITY_STYLE,
  NOAA_SMOKE_STYLE,
  type WildfirePopupTranslate,
} from "../presentation";
import { useWildfireStore } from "../store";
import type { NoaaSmokeProperties, WildfireFeatureCollection } from "../types";

export const NOAA_SMOKE_SOURCE = "openmapx-wildfires-noaa-smoke-source";
export const NOAA_SMOKE_FILL = "openmapx-wildfires-noaa-smoke-fill";
export const NOAA_SMOKE_LINE = "openmapx-wildfires-noaa-smoke-line";

const REFRESH_MS = 600_000;
const EMPTY_COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
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
    value.provider === "noaa-hms" &&
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

export interface NoaaSmokeLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

export function NoaaSmokeLayer({ active, popupController }: NoaaSmokeLayerProps) {
  const mapContext = useMap();
  const env = useEnv();
  const locale = useLocale();
  const translate = useTranslations("wildfires") as WildfirePopupTranslate;
  const popupLease = useRef<WildfirePopupLease>({});
  const setSourceStatus = useWildfireStore((state) => state.setSourceStatus);
  const resetSourceStatus = useWildfireStore((state) => state.resetSourceStatus);
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
      bridge.publish([{ sourceId: NOAA_SMOKE_SOURCE, data }]);
      setSourceStatus("noaa-hms", {
        loading: false,
        fetchedAt: Date.parse(data.fetchedAt),
        stale: data.stale,
        truncated: data.truncated,
        error: null,
        featureCount: data.features.length,
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

  useEffect(() => {
    void mapContext.styleVersion;
    const map = mapContext.mapRef.current;
    if (!map || !mapContext.mapReady) return;

    const remove = () => {
      try {
        if (map.getLayer(NOAA_SMOKE_LINE)) map.removeLayer(NOAA_SMOKE_LINE);
        if (map.getLayer(NOAA_SMOKE_FILL)) map.removeLayer(NOAA_SMOKE_FILL);
        if (map.getSource(NOAA_SMOKE_SOURCE)) map.removeSource(NOAA_SMOKE_SOURCE);
      } catch {
        // MapLibre may be replacing the style while cleanup runs.
      }
      unregisterLayerSlot(NOAA_SMOKE_FILL);
      unregisterLayerSlot(NOAA_SMOKE_LINE);
    };

    const sync = () => {
      if (!active) {
        remove();
        popupController.close(popupLease.current);
        return;
      }
      try {
        if (!map.getSource(NOAA_SMOKE_SOURCE)) {
          map.addSource(NOAA_SMOKE_SOURCE, { type: "geojson", data: EMPTY_COLLECTION });
        }
        if (!map.getLayer(NOAA_SMOKE_FILL)) {
          addLayerInSlot(
            map,
            {
              id: NOAA_SMOKE_FILL,
              type: "fill",
              source: NOAA_SMOKE_SOURCE,
              paint: { "fill-color": FILL_COLOR, "fill-opacity": FILL_OPACITY },
            },
            "area-overlays",
            3,
          );
        }
        if (!map.getLayer(NOAA_SMOKE_LINE)) {
          addLayerInSlot(
            map,
            {
              id: NOAA_SMOKE_LINE,
              type: "line",
              source: NOAA_SMOKE_SOURCE,
              paint: {
                "line-color": NOAA_SMOKE_STYLE.lineColor,
                "line-opacity": NOAA_SMOKE_STYLE.lineOpacity,
                "line-width": NOAA_SMOKE_STYLE.lineWidth,
              },
            },
            "area-overlays",
            4,
          );
        }
      } catch {
        // A subsequent styledata event retries once the new style is ready.
      }
    };

    sync();
    if (!active) return;
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
      remove();
      popupController.close(popupLease.current);
    };
  }, [active, mapContext.mapReady, mapContext.mapRef, mapContext.styleVersion, popupController]);

  useEffect(() => {
    const map = mapContext.mapRef.current;
    if (!map || !mapContext.mapReady || !active) return;

    const onClick = (event: MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties;
      if (!isNoaaSmokeProperties(properties)) return;
      const html = buildPopupCard(buildNoaaSmokePopupModel(properties, locale), translate);
      popupController.open(
        popupLease.current,
        new maplibregl.Popup({ closeButton: true, maxWidth: "320px", className: "omx-popup" })
          .setLngLat(event.lngLat)
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

    for (const layerId of [NOAA_SMOKE_FILL, NOAA_SMOKE_LINE]) {
      INTERACTIVE_LAYER_IDS.add(layerId);
      map.on("click", layerId, onClick);
      map.on("mouseenter", layerId, onMouseEnter);
      map.on("mouseleave", layerId, onMouseLeave);
    }
    return () => {
      for (const layerId of [NOAA_SMOKE_FILL, NOAA_SMOKE_LINE]) {
        map.off("click", layerId, onClick);
        map.off("mouseenter", layerId, onMouseEnter);
        map.off("mouseleave", layerId, onMouseLeave);
        INTERACTIVE_LAYER_IDS.delete(layerId);
      }
      map.getCanvasContainer().style.cursor = "";
    };
  }, [active, locale, mapContext.mapReady, mapContext.mapRef, popupController, translate]);

  return null;
}
