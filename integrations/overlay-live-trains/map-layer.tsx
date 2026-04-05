"use client";

import type { VehiclePosition } from "@openmapx/core";
import { escapeHtml, useLiveTrains, useOverlayExclusion } from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import {
  dbCategoryColor,
  liveTrainIconExpression,
  loadLiveTrainMarkers,
} from "@/lib/transitMarkers";
import { useLiveTrainsStore } from "./store";

const SOURCE_ID = "live-trains-source";
const ICON_LAYER = "live-trains-icon";
const LABEL_LAYER = "live-trains-label";

interface ParsedTrain {
  id: string;
  name: string;
  route: string;
  category: string;
  color: string;
  bearing: number;
  speed: number | null;
  tripId: string;
  lng: number;
  lat: number;
}

function parsePositions(positions: VehiclePosition[]): ParsedTrain[] {
  return positions.map((p) => {
    const [name = "", route = ""] = (p.label ?? "").split("\n");
    const category = name.split(" ")[0] ?? "";
    return {
      id: p.id,
      name,
      route,
      category,
      color: dbCategoryColor(category),
      bearing: p.bearing ?? 0,
      speed: p.speed != null ? Math.round(p.speed * 3.6) : null,
      tripId: p.tripId ?? "",
      lng: p.lng,
      lat: p.lat,
    };
  });
}

function buildGeoJson(trains: ParsedTrain[]) {
  return {
    type: "FeatureCollection" as const,
    features: trains.map((t) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [t.lng, t.lat] },
      properties: {
        id: t.id,
        name: t.name,
        route: t.route,
        category: t.category,
        color: t.color,
        bearing: t.bearing,
        speed: t.speed,
        tripId: t.tripId,
      },
    })),
  };
}

function buildPopupHtml(t: ParsedTrain): string {
  const name = escapeHtml(t.name);
  const route = escapeHtml(t.route);
  const details = [
    route ? `<div style="font-size:12px;color:#666">${route}</div>` : "",
    t.speed != null && t.speed > 0
      ? `<div style="font-size:12px;color:#666">${t.speed} km/h</div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:180px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="display:inline-flex;align-items:center;justify-content:center;background:${t.color};color:#fff;font-weight:700;font-size:14px;border-radius:6px;min-width:48px;height:32px;padding:0 10px">${name}</span>
    </div>
    ${details}
    <div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:5px;margin-top:5px">
      <a href="https://developers.deutschebahn.com" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">Deutsche Bahn</a>
    </div>
  </div>`;
}

export function LiveTrainsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useLiveTrainsStore((s) => s.layerVisible);
  const selectTrain = useLiveTrainsStore((s) => s.selectTrain);
  useOverlayExclusion("live-trains", layerVisible);
  useLayerReanchor([ICON_LAYER, LABEL_LAYER], layerVisible);

  const { data: positions } = useLiveTrains(layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupTrainIdRef = useRef<string | null>(null);
  const layerInitRef = useRef(false);

  // Click handler — opens popup for a train
  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const map = mapRef.current;
      if (!map) return;

      const props = feature.properties;
      const trainId = String(props?.id ?? "");
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];

      const train: ParsedTrain = {
        id: trainId,
        name: String(props?.name ?? ""),
        route: String(props?.route ?? ""),
        category: String(props?.category ?? ""),
        color: String(props?.color ?? "#8B5CF6"),
        bearing: Number(props?.bearing ?? 0),
        speed: props?.speed != null ? Number(props.speed) : null,
        tripId: String(props?.tripId ?? ""),
        lng: coords[0],
        lat: coords[1],
      };

      popupRef.current?.remove();
      popupTrainIdRef.current = trainId;

      const popup = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "280px",
        className: "omx-popup",
        offset: 16,
      })
        .setLngLat(coords)
        .setHTML(buildPopupHtml(train))
        .addTo(map);

      popup.on("close", () => {
        popupTrainIdRef.current = null;
      });
      popupRef.current = popup;

      selectTrain(trainId);
    },
    [mapRef, selectTrain],
  );

  // Update popup when positions refresh (keep it open, update content + position)
  useEffect(() => {
    if (!popupTrainIdRef.current || !popupRef.current || !positions?.length) return;

    const trains = parsePositions(positions);
    const train = trains.find((t) => t.id === popupTrainIdRef.current);

    if (!train) {
      // Train disappeared from data — close popup
      popupRef.current.remove();
      popupTrainIdRef.current = null;
      return;
    }

    // Update popup content and position
    popupRef.current.setLngLat([train.lng, train.lat]);
    popupRef.current.setHTML(buildPopupHtml(train));
  }, [positions]);

  // Layer setup — separate from data updates to avoid cleanup/recreation on poll
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!layerVisible) {
      try {
        if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
        if (map.getLayer(ICON_LAYER)) map.removeLayer(ICON_LAYER);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        /* race */
      }
      popupRef.current?.remove();
      popupTrainIdRef.current = null;
      layerInitRef.current = false;
      return;
    }

    if (!map.isStyleLoaded() || layerInitRef.current) return;

    loadLiveTrainMarkers(map);

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution:
        '© <a href="https://developers.deutschebahn.com" target="_blank">Deutsche Bahn</a>',
    });

    const beforeLayer = getFirstSymbolLayerId(map);

    map.addLayer(
      {
        id: ICON_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        layout: {
          "icon-image": liveTrainIconExpression() as maplibregl.ExpressionSpecification,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 8, 0.7, 12, 1],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
        },
      },
      beforeLayer,
    );

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      minzoom: 8,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.8],
        "text-anchor": "top",
        "text-optional": true,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#333",
        "text-halo-color": "#fff",
        "text-halo-width": 1.5,
      },
    });

    map.on("click", ICON_LAYER, handleClick);
    map.on("mouseenter", ICON_LAYER, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", ICON_LAYER, () => {
      map.getCanvas().style.cursor = "";
    });
    INTERACTIVE_LAYER_IDS.add(ICON_LAYER);

    layerInitRef.current = true;

    return () => {
      map.off("click", ICON_LAYER, handleClick);
      INTERACTIVE_LAYER_IDS.delete(ICON_LAYER);
      try {
        if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
        if (map.getLayer(ICON_LAYER)) map.removeLayer(ICON_LAYER);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        /* race */
      }
      layerInitRef.current = false;
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, handleClick]);

  // Data updates — just set source data, no layer recreation
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layerVisible || !positions?.length) return;

    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    source.setData(buildGeoJson(parsePositions(positions)));
  }, [mapRef, layerVisible, positions]);

  return null;
}
