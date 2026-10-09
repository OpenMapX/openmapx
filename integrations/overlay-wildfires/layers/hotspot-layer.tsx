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
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { HOTSPOT_POINTS_MIN_ZOOM } from "../bounds";
import {
  isFireDensityCollection,
  isFirmsFeatureCollection,
  readFirmsResponseMetadata,
} from "../firms-response";
import type { WildfirePopupController, WildfirePopupLease } from "../popup-controller";
import { useWildfireStore } from "../store";
import type { FireDensityCollection, FireFeatureCollection } from "../types";
import {
  useViewportWildfireSource,
  type ViewportReading,
  type ViewportResponse,
} from "./use-viewport-wildfire-source";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const HEATMAP_LAYER_ID = "openmapx-wildfires-heatmap";
export const DENSITY_SOURCE_ID = "openmapx-wildfires-density-source";
export const DENSITY_LAYER_ID = "openmapx-wildfires-density";
const DENSITY_HEATMAP_LAYER_ID = "openmapx-wildfires-density-heatmap";

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Older detections change less often, so a longer range refreshes less often. */
const REFRESH_MS: Record<1 | 2 | 3, number> = {
  1: 300_000,
  2: 600_000,
  3: 900_000,
};

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

/** A density cell grows with the number of detections in it. */
const DENSITY_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "count"],
  1,
  4,
  10,
  7,
  100,
  12,
  1000,
  18,
  10000,
  26,
];

/** A density cell is coloured by its strongest fire. */
export const DENSITY_COLOR_STOPS = [
  { frp: 0, color: "#fcd34d" },
  { frp: 10, color: "#fb923c" },
  { frp: 100, color: "#f97316" },
  { frp: 500, color: "#ef4444" },
  { frp: 1000, color: "#b91c1c" },
] as const;

const DENSITY_COLOR_EXPR = [
  "interpolate",
  ["linear"],
  ["get", "frpMax"],
  ...DENSITY_COLOR_STOPS.flatMap(({ frp, color }) => [frp, color]),
] as maplibregl.ExpressionSpecification;

type HotspotData =
  | { kind: "points"; collection: FireFeatureCollection }
  | { kind: "density"; collection: FireDensityCollection };

export interface HotspotLayerProps {
  active: boolean;
  popupController: WildfirePopupController;
}

function confidenceLabel(conf: string): string | null {
  if (conf === "high") return "High";
  if (conf === "nominal") return "Nominal";
  if (conf === "low") return "Low";
  const num = Number.parseInt(conf, 10);
  if (!Number.isNaN(num)) return `${num}%`;
  return conf ? escapeHtml(conf) : null;
}

function popupLine(label: string, value: string): string {
  return `<div style="font-size:12px;color:#666">${label}: ${value}</div>`;
}

function frpColor(frp: number): string {
  return frp >= 500 ? "#dc2626" : frp >= 100 ? "#f97316" : frp >= 10 ? "#eab308" : "#94a3b8";
}

export function buildHotspotPopupHtml(
  p: Record<string, unknown>,
  coords: [number, number],
  t: (key: string) => string,
): string {
  const frp = Number(p.frp ?? 0);
  const brightness = p.brightness == null ? null : Number(p.brightness);
  const confidence = p.confidence == null ? null : confidenceLabel(String(p.confidence));
  const satellite = p.satellite == null ? null : escapeHtml(String(p.satellite));
  const ageMs = Number(p.ageMs ?? 0);
  const dayNight = p.dayNight == null ? null : String(p.dayNight);
  const acqDate = escapeHtml(String(p.acqDate ?? ""));
  const timeStr = String(p.acqTime ?? "").padStart(4, "0");
  const formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)} UTC`;

  const lines = [
    brightness !== null && Number.isFinite(brightness)
      ? popupLine(t("brightness"), `${brightness.toFixed(1)} K`)
      : "",
    confidence ? popupLine(t("confidence"), confidence) : "",
    satellite ? popupLine(t("satellite"), satellite) : "",
    popupLine(t("detected"), `${relativeTime(ageMs)} (${acqDate} ${formattedTime})`),
    dayNight ? popupLine(t("observation"), dayNight === "D" ? t("daytime") : t("nighttime")) : "",
    popupLine(t("coordinates"), `${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`),
  ].join("");

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;padding-right:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="display:inline-flex;align-items:center;justify-content:center;background:${frpColor(frp)};color:#fff;font-weight:700;font-size:13px;border-radius:6px;min-width:48px;height:32px;padding:0 8px;white-space:nowrap">${frp.toFixed(1)} MW</span>
          <div style="font-size:12px;color:#666">${t("fireRadiativePower")}</div>
        </div>
        ${lines}
      </div>`;
}

export function buildDensityPopupHtml(
  p: Record<string, unknown>,
  t: (key: string) => string,
): string {
  const count = Number(p.count ?? 0);
  const frpMax = Number(p.frpMax ?? 0);
  const frpSum = Number(p.frpSum ?? 0);
  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;padding-right:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="display:inline-flex;align-items:center;justify-content:center;background:${frpColor(frpMax)};color:#fff;font-weight:700;font-size:13px;border-radius:6px;min-width:48px;height:32px;padding:0 8px;white-space:nowrap">${count}</span>
          <div style="font-size:12px;color:#666">${t("detections")}</div>
        </div>
        ${popupLine(t("maxFirePower"), `${frpMax.toFixed(1)} MW`)}
        ${popupLine(t("totalFirePower"), `${frpSum.toFixed(1)} MW`)}
        <div style="font-size:11px;color:#666;margin-top:6px">${t("zoomInForHotspots")}</div>
      </div>`;
}

export function HotspotLayer({ active, popupController }: HotspotLayerProps) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const dayRange = useWildfireStore((s) => s.dayRange);
  const instrument = useWildfireStore((s) => s.source);
  const showHeatmap = useWildfireStore((s) => s.showHeatmap);
  const t = useTranslations("wildfires");
  const popupLease = useRef<WildfirePopupLease>({});
  const bridge = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: active,
  });

  // Individual detections from the zoom where a view holds a readable number of them; below
  // it, detections counted per grid cell.
  const endpoint = useCallback(
    (zoom: number) =>
      `${apiUrl}/api/integrations/overlay-wildfires/${zoom >= HOTSPOT_POINTS_MIN_ZOOM ? "wildfires" : "wildfires/density"}?dayRange=${dayRange}&instrument=${instrument}`,
    [apiUrl, dayRange, instrument],
  );

  const read = useCallback(
    ({
      body,
      headers,
      zoom,
      receivedAt,
    }: ViewportResponse): ViewportReading<HotspotData> | null => {
      const { fetchedAt, stale, truncated, sources } = readFirmsResponseMetadata(
        headers,
        receivedAt,
      );
      if (zoom >= HOTSPOT_POINTS_MIN_ZOOM) {
        if (!isFirmsFeatureCollection(body, instrument)) return null;
        return {
          data: { kind: "points", collection: body },
          fetchedAt,
          stale,
          truncated,
          featureCount: body.features.length,
          sources,
        };
      }
      if (!isFireDensityCollection(body)) return null;
      return {
        data: { kind: "density", collection: body },
        fetchedAt,
        stale,
        truncated,
        featureCount: body.features.reduce((sum, cell) => sum + cell.properties.count, 0),
        sources: body.sources,
      };
    },
    [instrument],
  );

  const publish = useCallback(
    (data: HotspotData) => {
      bridge.publish(
        data.kind === "points"
          ? [
              { sourceId: SOURCE_ID, data: data.collection },
              { sourceId: DENSITY_SOURCE_ID, data: EMPTY_COLLECTION },
            ]
          : [
              { sourceId: DENSITY_SOURCE_ID, data: data.collection },
              { sourceId: SOURCE_ID, data: EMPTY_COLLECTION },
            ],
      );
    },
    [bridge.publish],
  );

  const clear = useCallback(() => {
    bridge.reset([
      { sourceId: SOURCE_ID, data: EMPTY_COLLECTION },
      { sourceId: DENSITY_SOURCE_ID, data: EMPTY_COLLECTION },
    ]);
  }, [bridge.reset]);

  useViewportWildfireSource<HotspotData>({
    active,
    sourceId: "firms",
    endpoint,
    minZoom: 0,
    refreshMs: REFRESH_MS[dayRange],
    read,
    publish,
    clear,
  });

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!active) {
        try {
          for (const id of [
            HEATMAP_LAYER_ID,
            DENSITY_HEATMAP_LAYER_ID,
            CIRCLE_LAYER_ID,
            DENSITY_LAYER_ID,
          ]) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
          if (map.getSource(DENSITY_SOURCE_ID)) map.removeSource(DENSITY_SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        for (const id of [
          HEATMAP_LAYER_ID,
          DENSITY_HEATMAP_LAYER_ID,
          CIRCLE_LAYER_ID,
          DENSITY_LAYER_ID,
        ]) {
          unregisterLayerSlot(id);
        }
        popupController.close(popupLease.current);
        return;
      }

      try {
        for (const sourceId of [SOURCE_ID, DENSITY_SOURCE_ID]) {
          if (!map.getSource(sourceId)) {
            map.addSource(sourceId, { type: "geojson", data: EMPTY_COLLECTION });
          }
        }

        if (!map.getLayer(DENSITY_LAYER_ID)) {
          addLayerInSlot(
            map,
            {
              id: DENSITY_LAYER_ID,
              type: "circle",
              source: DENSITY_SOURCE_ID,
              paint: {
                "circle-radius": DENSITY_RADIUS_EXPR,
                "circle-color": DENSITY_COLOR_EXPR,
                "circle-opacity": 0.75,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 0.8,
              },
            },
            "overlay-points",
            3.5,
          );
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
      } catch {
        // Style not ready — styledata will retry
      }
    };

    if (!active) {
      syncLayers();
      return;
    }

    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
      popupController.close(popupLease.current);
    };
  }, [mapReady, mapRef, styleVersion, active, popupController]);

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
    syncHeatmapLayer(map, {
      enabled: showHeatmap,
      layerId: DENSITY_HEATMAP_LAYER_ID,
      sourceId: DENSITY_SOURCE_ID,
      weightProperty: "frpSum",
      weightMax: 1000,
      // Between the detection heatmap (0) and the earthquake heatmap (1).
      order: 0.5,
    });
  }, [mapRef, mapReady, styleVersion, active, showHeatmap]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const openPopup = (coords: [number, number], html: string) => {
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

    const onHotspotClick = (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      openPopup(coords, buildHotspotPopupHtml(f.properties as Record<string, unknown>, coords, t));
    };

    const onDensityClick = (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      openPopup(coords, buildDensityPopupHtml(f.properties as Record<string, unknown>, t));
    };

    const onMouseEnter = () => {
      map.getCanvasContainer().style.cursor = "pointer";
    };

    const onMouseLeave = () => {
      map.getCanvasContainer().style.cursor = "";
    };

    map.on("click", CIRCLE_LAYER_ID, onHotspotClick);
    map.on("click", DENSITY_LAYER_ID, onDensityClick);
    for (const layerId of [CIRCLE_LAYER_ID, DENSITY_LAYER_ID]) {
      map.on("mouseenter", layerId, onMouseEnter);
      map.on("mouseleave", layerId, onMouseLeave);
      INTERACTIVE_LAYER_IDS.add(layerId);
    }

    return () => {
      map.off("click", CIRCLE_LAYER_ID, onHotspotClick);
      map.off("click", DENSITY_LAYER_ID, onDensityClick);
      for (const layerId of [CIRCLE_LAYER_ID, DENSITY_LAYER_ID]) {
        map.off("mouseenter", layerId, onMouseEnter);
        map.off("mouseleave", layerId, onMouseLeave);
        INTERACTIVE_LAYER_IDS.delete(layerId);
      }
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapReady, mapRef, styleVersion, active, popupController, t]);

  return null;
}
