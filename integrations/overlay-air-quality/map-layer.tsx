"use client";

import { escapeHtml, sanitizeUrl, useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { useAirQualityStore } from "./store";

const AQ_SOURCE_ID = "openaq-air-quality";
const AQ_LAYER_ID = "air-quality-layer";

/** Neutral sequential scale for PM2.5 concentration; these are not health categories. */
export const PM25_COLORS: [number, string][] = [
  [0, "#2c7bb6"],
  [10, "#00a6ca"],
  [25, "#00ccbc"],
  [50, "#90eb9d"],
  [75, "#f9d057"],
  [100, "#f29e2e"],
];

interface AQStation {
  id: number;
  name: string;
  lat: number;
  lng: number;
  aqi: number | null;
  pm25: number;
  lastUpdated: string;
  attribution: { name: string; url: string | null } | null;
  license: string | null;
}

export function buildGeoJson(stations: AQStation[]) {
  return {
    type: "FeatureCollection" as const,
    features: stations.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        aqi: s.aqi,
        pm25: s.pm25,
        lastUpdated: s.lastUpdated,
        attributionName: s.attribution?.name ?? "",
        attributionUrl: s.attribution?.url ?? "",
        license: s.license ?? "",
      },
    })),
  };
}

export function buildStationPopupHtml(p: Record<string, string | number | null>): string {
  const pm25 = Number(p.pm25);
  const attrName = escapeHtml(String(p.attributionName || ""));
  const attrUrl = sanitizeUrl(String(p.attributionUrl || ""));
  const license = escapeHtml(String(p.license || ""));
  const attrLink = attrUrl
    ? `<a href="${attrUrl}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${attrName}</a>`
    : attrName;
  const attrHtml = attrName
    ? `${attrLink}${license ? ` (${license})` : ""} via <a href="https://openaq.org" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">OpenAQ</a>`
    : `<a href="https://openaq.org" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">OpenAQ</a>`;
  return `
    <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">${escapeHtml(String(p.name))}</div>
      <div style="font-size:20px;font-weight:700;color:#222">${pm25.toFixed(1)} µg/m³</div>
      <div style="font-size:12px;color:#777;margin-top:2px">PM2.5 concentration</div>
      <div style="font-size:11px;color:#777;margin-top:6px">${escapeHtml(String(p.lastUpdated || ""))}</div>
      <div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:6px;margin-top:6px">${attrHtml}</div>
    </div>`;
}

export function AirQualityLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the circles hidden, so an
  // overlay left on while zooming out can't pull stations for a continent.
  const minZoom = useOverlayMinZoom("air-quality");
  const setLoading = useAirQualityStore((s) => s.setLoading);
  const setError = useAirQualityStore((s) => s.setError);
  useIntegrationAttribution("overlay-air-quality", layerVisible);
  useOverlayExclusion("air-quality", layerVisible);
  const fetchedRef = useRef(false);
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
    const { apiUrl } = env;
    const url = `${apiUrl}/api/integrations/overlay-air-quality/air-quality/stations?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;

    const request = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent()) return;
      if (!res.ok) {
        setError(res.status === 429 ? "quota" : "unavailable");
        return;
      }
      const providerStatus = res.headers?.get?.("x-openmapx-air-quality-status");
      if (providerStatus === "quota-truncated") setError("quota");
      else if (providerStatus === "coverage-truncated") setError("coverage");
      else if (providerStatus === "upstream-unavailable") setError("unavailable");
      const stations = (await res.json()) as AQStation[];
      if (!request.isCurrent()) return;
      const geojson = buildGeoJson(stations);

      publishGeoJson([{ sourceId: AQ_SOURCE_ID, data: geojson }]);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setError("unavailable");
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [beginRequest, env, mapRef, publishGeoJson, setError, setLoading, minZoom]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(AQ_LAYER_ID)) map.removeLayer(AQ_LAYER_ID);
          if (map.getSource(AQ_SOURCE_ID)) map.removeSource(AQ_SOURCE_ID);
        } catch {
          // Source may still be in-flight
        }
        unregisterLayerSlot(AQ_LAYER_ID);
        popupRef.current?.remove();
        fetchedRef.current = false;
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (!map.getSource(AQ_SOURCE_ID)) {
        map.addSource(AQ_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer(AQ_LAYER_ID)) {
        const colorExpr: unknown[] = ["interpolate", ["linear"], ["get", "pm25"]];
        for (const [concentration, color] of PM25_COLORS) {
          colorExpr.push(concentration, color);
        }

        addLayerInSlot(
          map,
          {
            id: AQ_LAYER_ID,
            type: "circle",
            source: AQ_SOURCE_ID,
            minzoom: minZoom,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["min", ["get", "pm25"], 100],
                0,
                5,
                100,
                14,
              ],
              "circle-color": colorExpr as maplibregl.ExpressionSpecification,
              "circle-opacity": 0.75,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
              "circle-stroke-opacity": 0.5,
            },
          },
          "overlay-points",
          0,
        );
      }

      if (!fetchedRef.current) {
        fetchedRef.current = true;
        void fetchStations();
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
  }, [mapReady, styleVersion, mapRef, layerVisible, fetchStations, minZoom]);

  const debouncedFetch = useDebouncedCallback(() => fetchStations(), 800);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, debouncedFetch]);

  // Click popup with station info + attribution
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      const html = buildStationPopupHtml(p);

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
      if (!map.getLayer(AQ_LAYER_ID)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [AQ_LAYER_ID] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    map.on("click", AQ_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(AQ_LAYER_ID);

    return () => {
      map.off("click", AQ_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
      INTERACTIVE_LAYER_IDS.delete(AQ_LAYER_ID);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  return null;
}
