"use client";

import { escapeHtml, useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import {
  type ContributingRecord,
  readCapturedContributors,
  withFeatureContributors,
} from "@openmapx/integration-framework";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { attributionToHtml } from "@/integration-api/overlay/useMapAttributions";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { type EnvironmentSensorType, useEnvironmentStore } from "./store";

const ENV_SOURCE_ID = "opensensemap-env";
const ENV_LAYER_ID = "env-circle-layer";
const ENV_LABEL_LAYER_ID = "env-label-layer";

interface ColorScale {
  stops: [number, string][];
  unit: string;
}

const COLOR_SCALES: Record<EnvironmentSensorType, ColorScale> = {
  temperature: {
    stops: [
      [-10, "#2196F3"],
      [0, "#4FC3F7"],
      [15, "#66BB6A"],
      [25, "#FFA726"],
      [35, "#E53935"],
    ],
    unit: "°C",
  },
  humidity: {
    stops: [
      [20, "#FDD835"],
      [50, "#66BB6A"],
      [90, "#1E88E5"],
    ],
    unit: "%",
  },
  pm25: {
    stops: [
      [0, "#66BB6A"],
      [35, "#FDD835"],
      [75, "#FF9800"],
      [150, "#E53935"],
    ],
    unit: "µg/m³",
  },
  pm10: {
    stops: [
      [0, "#66BB6A"],
      [50, "#FDD835"],
      [100, "#FF9800"],
      [250, "#E53935"],
    ],
    unit: "µg/m³",
  },
  pressure: {
    stops: [
      [980, "#42A5F5"],
      [1000, "#66BB6A"],
      [1013, "#A5D6A7"],
      [1030, "#FFA726"],
      [1040, "#FF7043"],
    ],
    unit: "hPa",
  },
  uv: {
    stops: [
      [0, "#66BB6A"],
      [3, "#FDD835"],
      [6, "#FF9800"],
      [8, "#E53935"],
      [11, "#7B1FA2"],
    ],
    unit: "UV",
  },
  noise: {
    stops: [
      [30, "#66BB6A"],
      [50, "#FDD835"],
      [70, "#FF9800"],
      [85, "#E53935"],
    ],
    unit: "dB",
  },
};

interface SensorReading {
  title: string;
  value: number;
  unit: string;
}

interface EnvStation extends ContributingRecord {
  id: string;
  name: string;
  lat: number;
  lng: number;
  value: number;
  unit: string;
  sensorTitle: string;
  sensorType: string;
  lastUpdated: string;
  exposure: string;
  model: string;
  allSensors: SensorReading[];
}

function buildGeoJson(stations: EnvStation[]) {
  return {
    type: "FeatureCollection" as const,
    features: stations.map((s) =>
      withFeatureContributors(
        {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
          properties: {
            id: s.id,
            name: s.name,
            value: s.value,
            unit: s.unit,
            sensorTitle: s.sensorTitle,
            lastUpdated: s.lastUpdated,
            model: s.model,
            allSensors: JSON.stringify(s.allSensors),
            label: `${Math.round(s.value)}`,
          },
        },
        s.contributors ?? [],
      ),
    ),
  };
}

function buildColorExpr(scale: ColorScale): unknown[] {
  const expr: unknown[] = ["interpolate", ["linear"], ["get", "value"]];
  for (const [stop, color] of scale.stops) {
    expr.push(stop, color);
  }
  return expr;
}

function environmentGroup(scale: ColorScale, minZoom: number): MapLayerGroup {
  return {
    sources: { [ENV_SOURCE_ID]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION } },
    layers: [
      {
        id: ENV_LAYER_ID,
        type: "circle",
        source: ENV_SOURCE_ID,
        minzoom: minZoom,
        slot: "overlay-points",
        order: 1,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 5, 10, 14, 14, 18],
          "circle-color": buildColorExpr(scale) as maplibregl.ExpressionSpecification,
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 7, 1, 10, 2],
          "circle-stroke-opacity": 0.8,
        },
      },
      {
        id: ENV_LABEL_LAYER_ID,
        type: "symbol",
        source: ENV_SOURCE_ID,
        minzoom: 10,
        slot: "overlay-markers",
        order: 3,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 13],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#ffffff",
        },
      },
    ],
  };
}

export function EnvironmentLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useEnvironmentStore((s) => s.layerVisible);
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the circles hidden, so an
  // overlay left on while zooming out can't pull stations for a continent.
  const minZoom = useOverlayMinZoom("environment");
  useRenderedMapAttributions("environment", [ENV_LAYER_ID, ENV_LABEL_LAYER_ID], layerVisible);
  const sensorType = useEnvironmentStore((s) => s.sensorType);
  const setLoading = useEnvironmentStore((s) => s.setLoading);
  const setStationCount = useEnvironmentStore((s) => s.setStationCount);

  useOverlayExclusion("environment", layerVisible);

  const popupRef = useRef<maplibregl.Popup | null>(null);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });

  const fetchStations = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < minZoom) return;

    const bounds = map.getBounds();
    const url =
      `${env.apiUrl}/api/integrations/overlay-environment/stations` +
      `?south=${bounds.getSouth()}&west=${bounds.getWest()}` +
      `&north=${bounds.getNorth()}&east=${bounds.getEast()}` +
      `&sensor=${sensorType}`;

    const request = beginRequest();
    setLoading(true);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent() || !res.ok) return;
      const stations = (await res.json()) as EnvStation[];
      if (!request.isCurrent()) return;
      setStationCount(stations.length);

      const geojson = buildGeoJson(stations);
      publishGeoJson([{ sourceId: ENV_SOURCE_ID, data: geojson }]);
    } catch {
      // silent
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [
    beginRequest,
    env.apiUrl,
    mapRef,
    sensorType,
    publishGeoJson,
    setLoading,
    setStationCount,
    minZoom,
  ]);

  useMapLayerGroup(
    useMemo(
      () => (layerVisible ? environmentGroup(COLOR_SCALES[sensorType], minZoom) : null),
      [layerVisible, sensorType, minZoom],
    ),
  );

  // Showing the overlay or switching sensor fetches the viewport immediately.
  useEffect(() => {
    if (!mapReady) return;
    if (layerVisible) void fetchStations();
    else setStationCount(0);
  }, [mapReady, layerVisible, fetchStations, setStationCount]);

  const debouncedFetch = useDebouncedCallback(() => {
    void fetchStations();
  }, 800);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, debouncedFetch]);

  // Click popup
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];

      const name = escapeHtml(String(p.name || "Station"));
      const model = escapeHtml(String(p.model || ""));
      const lastUp = p.lastUpdated ? new Date(String(p.lastUpdated)).toLocaleString() : "";

      // Parse all sensors from JSON string
      let allSensors: SensorReading[] = [];
      try {
        allSensors = JSON.parse(String(p.allSensors || "[]")) as SensorReading[];
      } catch {
        // fallback to just the primary sensor
        allSensors = [
          {
            title: String(p.sensorTitle || ""),
            value: Number(p.value),
            unit: String(p.unit || ""),
          },
        ];
      }

      const sensorsHtml = allSensors
        .map(
          (s) =>
            `<div style="display:flex;justify-content:space-between;gap:8px;padding:1px 0">` +
            `<span style="color:#666">${escapeHtml(s.title)}</span>` +
            `<span style="font-weight:500">${s.value.toFixed(1)} ${escapeHtml(s.unit)}</span>` +
            `</div>`,
        )
        .join("");

      const html = `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px">
          <div style="font-size:14px;font-weight:600;margin-bottom:2px">${name}</div>
          ${model ? `<div style="font-size:11px;color:#999;margin-bottom:6px">${model}</div>` : ""}
          <div style="font-size:12px;margin-bottom:4px">${sensorsHtml}</div>
          ${lastUp ? `<div style="font-size:11px;color:#999;margin-bottom:4px">${lastUp}</div>` : ""}
          <div style="font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:4px">
            ${(readCapturedContributors(p._mapAttributions) ?? []).map(attributionToHtml).join(" · ")}
          </div>
        </div>`;

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "260px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(ENV_LAYER_ID)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [ENV_LAYER_ID] });
      map.getCanvasContainer().style.cursor = features.length > 0 ? "pointer" : "";
    };

    map.on("click", ENV_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(ENV_LAYER_ID);

    return () => {
      map.off("click", ENV_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
      INTERACTIVE_LAYER_IDS.delete(ENV_LAYER_ID);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  return null;
}
