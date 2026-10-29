"use client";

import { escapeHtml, useDebouncedCallback } from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useHikingStore } from "./store";

const SOURCE_ID = "openmapx-shelters-source";
const CIRCLE_LAYER_ID = "openmapx-shelters-circles";
const LABEL_LAYER_ID = "openmapx-shelters-labels";
const INTERACTIVE_LAYERS = [CIRCLE_LAYER_ID] as const;
const MIN_ZOOM = 10;

const SHELTER_COLORS: Record<string, string> = {
  refuge: "#D84315",
  cabane: "#795548",
  gite: "#5D4037",
  pt_eau: "#0288D1",
  pt_passage: "#546E7A",
};

const SHELTER_TYPE_KEYS: Record<string, string> = {
  refuge: "refuge",
  cabane: "cabin",
  gite: "guesthouse",
  pt_eau: "waterPoint",
  pt_passage: "mountainPass",
};

const SHELTER_GROUP: MapLayerGroup = {
  sources: { [SOURCE_ID]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION } },
  layers: [
    {
      id: CIRCLE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      slot: "overlay-points",
      order: 7,
      paint: {
        "circle-color": [
          "match",
          ["get", "type"],
          "refuge",
          SHELTER_COLORS.refuge,
          "cabane",
          SHELTER_COLORS.cabane,
          "gite",
          SHELTER_COLORS.gite,
          "pt_eau",
          SHELTER_COLORS.pt_eau,
          "pt_passage",
          SHELTER_COLORS.pt_passage,
          "#795548",
        ],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], MIN_ZOOM, 4, 16, 8],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.9,
      },
    },
    {
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      minzoom: 12,
      slot: "overlay-markers",
      order: 4,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-optional": true,
        "text-max-width": 8,
      },
      paint: {
        "text-color": "#333333",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5,
      },
    },
  ],
};

export function MountainShelterLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useHikingStore((s) => s.layerVisible);
  useRenderedMapAttributions("hiking-shelters", [CIRCLE_LAYER_ID, LABEL_LAYER_ID], layerVisible);
  const t = useTranslations("hiking");
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });
  const shelterLabelsRef = useRef<Record<string, string>>({});
  shelterLabelsRef.current = Object.fromEntries(
    Object.entries(SHELTER_TYPE_KEYS).map(([type, key]) => [type, t(key)]),
  );

  const fetchShelters = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < MIN_ZOOM) return;

    const bounds = map.getBounds();
    const { apiUrl } = env;
    const url = `${apiUrl}/api/integrations/overlay-hiking/hiking/shelters?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;

    const request = beginRequest();
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent() || !res.ok) return;
      const data = await res.json();
      if (!request.isCurrent()) return;
      publishGeoJson([{ sourceId: SOURCE_ID, data }]);
    } catch {
      // Silent failure
    }
  }, [beginRequest, env, mapRef, publishGeoJson]);

  useMapLayerGroup(layerVisible ? SHELTER_GROUP : null);

  // Showing the overlay fetches the view immediately.
  useEffect(() => {
    if (mapReady && layerVisible) void fetchShelters();
  }, [mapReady, layerVisible, fetchShelters]);

  // Refetch on pan/zoom
  const debouncedFetch = useDebouncedCallback(() => void fetchShelters(), 800);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, mapRef, layerVisible, debouncedFetch]);

  // Click popup + cursor; hiding the overlay closes the popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      const name = escapeHtml(String(props.name || "Shelter"));
      const type = String(props.type || "");
      const typeLabel = shelterLabelsRef.current[type] || type;
      const altitude = props.altitude ? `${props.altitude} m` : "";
      const capacity = props.capacity ? String(props.capacity) : "";

      const details = [typeLabel, altitude, capacity ? `${capacity} beds` : ""]
        .filter(Boolean)
        .map((part) => escapeHtml(part))
        .join(" · ");

      const html = `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:180px;padding-right:18px">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">${name}</div>
        <div style="font-size:12px;color:#666;margin-bottom:2px">${details}</div>
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

    const onMouseMove = (e: MapMouseEvent) => {
      const activeLayers = INTERACTIVE_LAYERS.filter((id) => !!map.getLayer(id));
      if (activeLayers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [...activeLayers] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    map.on("click", CIRCLE_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);

    return () => {
      map.off("click", CIRCLE_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, mapRef, layerVisible]);

  return null;
}
