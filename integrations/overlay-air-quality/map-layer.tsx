"use client";

import { escapeHtml, sanitizeUrl, useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import type { MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
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

/** AQI color scale (US EPA standard). */
const AQI_COLORS: [number, string][] = [
  [0, "#009966"],
  [51, "#ffde33"],
  [101, "#ff9933"],
  [151, "#cc0033"],
  [201, "#660099"],
  [301, "#7e0023"],
];

const AQI_LABELS: [number, string][] = [
  [0, "Good"],
  [51, "Moderate"],
  [101, "Unhealthy for sensitive groups"],
  [151, "Unhealthy"],
  [201, "Very unhealthy"],
  [301, "Hazardous"],
];

function aqiLabel(aqi: number): string {
  let label = "Good";
  for (const [threshold, l] of AQI_LABELS) {
    if (aqi >= threshold) label = l;
  }
  return label;
}

function aqiColor(aqi: number): string {
  let color = AQI_COLORS[0][1];
  for (const [threshold, c] of AQI_COLORS) {
    if (aqi >= threshold) color = c;
  }
  return color;
}

interface AQStation {
  id: number;
  name: string;
  lat: number;
  lng: number;
  aqi: number;
  pm25: number;
  lastUpdated: string;
  attribution: { name: string; url: string } | null;
  license: string | null;
}

function buildGeoJson(stations: AQStation[]) {
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

export function AirQualityLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the circles hidden, so an
  // overlay left on while zooming out can't pull stations for a continent.
  const minZoom = useOverlayMinZoom("air-quality");
  const setLoading = useAirQualityStore((s) => s.setLoading);
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
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent() || !res.ok) return;
      const stations = (await res.json()) as AQStation[];
      if (!request.isCurrent()) return;
      const geojson = buildGeoJson(stations);

      publishGeoJson([{ sourceId: AQ_SOURCE_ID, data: geojson }]);
    } catch {
      // Silent fetch failure
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [beginRequest, env, mapRef, publishGeoJson, setLoading, minZoom]);

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
        const colorExpr: unknown[] = ["step", ["get", "aqi"]];
        colorExpr.push(AQI_COLORS[0][1]);
        for (let i = 1; i < AQI_COLORS.length; i++) {
          colorExpr.push(AQI_COLORS[i][0], AQI_COLORS[i][1]);
        }

        addLayerInSlot(
          map,
          {
            id: AQ_LAYER_ID,
            type: "circle",
            source: AQ_SOURCE_ID,
            minzoom: minZoom,
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 8, 8, 12, 14],
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
        fetchStations();
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
      const aqi = Number(p.aqi);
      const pm25 = Number(p.pm25);
      const label = aqiLabel(aqi);
      const color = aqiColor(aqi);

      const attrName = escapeHtml(String(p.attributionName || ""));
      const attrUrl = sanitizeUrl(String(p.attributionUrl || ""));
      const license = escapeHtml(String(p.license || ""));
      const attrLink = attrUrl
        ? `<a href="${attrUrl}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${attrName}</a>`
        : attrName;
      const attrHtml = attrName
        ? `${attrLink}${license ? ` (${license})` : ""} via <a href="https://openaq.org" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">OpenAQ</a>`
        : `<a href="https://openaq.org" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">OpenAQ</a>`;

      const html = `
        <div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px">
          <div style="font-size:14px;font-weight:600;margin-bottom:8px">${escapeHtml(String(p.name))}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="display:inline-flex;align-items:center;justify-content:center;background:${color};color:#fff;font-weight:700;font-size:18px;border-radius:6px;min-width:48px;height:36px;padding:0 8px">${aqi}</span>
            <div>
              <div style="font-size:13px;font-weight:500;color:#333">${label}</div>
              <div style="font-size:12px;color:#777">PM2.5: ${pm25.toFixed(1)} µg/m³</div>
            </div>
          </div>
          <div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:6px;margin-top:2px">
            ${attrHtml}
          </div>
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
