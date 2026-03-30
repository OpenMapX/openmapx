"use client";

import { useDebouncedCallback, useHikingStore } from "@openmapx/core";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useLayerReanchor } from "./useLayerReanchor";

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

export function MountainShelterLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useHikingStore((s) => s.layerVisible);
  useLayerReanchor([CIRCLE_LAYER_ID, LABEL_LAYER_ID], layerVisible);
  const t = useTranslations("hiking");
  const fetchedRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const shelterLabelsRef = useRef<Record<string, string>>({});
  shelterLabelsRef.current = Object.fromEntries(
    Object.entries(SHELTER_TYPE_KEYS).map(([type, key]) => [type, t(key)]),
  );

  const fetchShelters = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < MIN_ZOOM) return;

    const bounds = map.getBounds();
    const { apiUrl } = env;
    const url = `${apiUrl}/api/hiking/shelters?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      }
    } catch {
      // Silent failure
    }
  }, [env, mapRef]);

  // Combined layer management + initial fetch
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        popupRef.current?.remove();
        fetchedRef.current = false;
        return;
      }

      // Try to create source + layers. No isStyleLoaded() gate — just catch errors.
      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            attribution:
              '© <a href="https://www.refuges.info" target="_blank">Refuges.info</a> (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank">CC BY-SA 2.0</a>)',
          });
        }

        if (!map.getLayer(CIRCLE_LAYER_ID)) {
          map.addLayer({
            id: CIRCLE_LAYER_ID,
            type: "circle",
            source: SOURCE_ID,
            minzoom: MIN_ZOOM,
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
          });
        }

        if (!map.getLayer(LABEL_LAYER_ID)) {
          map.addLayer({
            id: LABEL_LAYER_ID,
            type: "symbol",
            source: SOURCE_ID,
            minzoom: 12,
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
          });
        }

        // Source exists — trigger initial fetch
        if (!fetchedRef.current) {
          fetchedRef.current = true;
          fetchShelters();
        }
      } catch {
        // Style not ready yet — styledata will retry
      }
    };

    if (!layerVisible) {
      syncLayers();
      return;
    }

    syncLayers();
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, fetchShelters]);

  // Refetch on pan/zoom
  const debouncedFetch = useDebouncedCallback(() => fetchShelters(), 800);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, debouncedFetch]);

  // Click popup + cursor
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, string | number>;
      const coords = (f.geometry as { coordinates: number[] }).coordinates as [number, number];
      const name = String(props.name || "Shelter");
      const type = String(props.type || "");
      const typeLabel = shelterLabelsRef.current[type] || type;
      const altitude = props.altitude ? `${props.altitude} m` : "";
      const capacity = props.capacity ? String(props.capacity) : "";

      const details = [typeLabel, altitude, capacity ? `${capacity} beds` : ""]
        .filter(Boolean)
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
  }, [mapReady, styleVersion, mapRef, layerVisible]);

  return null;
}
