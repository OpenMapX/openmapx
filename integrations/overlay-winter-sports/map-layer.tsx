"use client";

import {
  buildIntegrationAttribution,
  escapeHtml,
  useDebouncedCallback,
  useIntegrationRegistry,
  useOverlayExclusion,
} from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useWinterSportsStore } from "./store";

const RASTER_SOURCE_ID = "openmapx-opensnowmap-source";
const RASTER_LAYER_ID = "openmapx-opensnowmap-layer";
const VECTOR_SOURCE_ID = "openmapx-winter-sports-vector";
const PISTE_LAYER_ID = "openmapx-winter-pistes";
const PISTE_HIGHLIGHT_LAYER_ID = "openmapx-winter-piste-highlight";
const LIFT_LAYER_ID = "openmapx-winter-lifts";
const LIFT_HIGHLIGHT_LAYER_ID = "openmapx-winter-lift-highlight";
const AREA_LAYER_ID = "openmapx-winter-areas";
const INTERACTIVE_LAYERS = [PISTE_LAYER_ID, LIFT_LAYER_ID] as const;
const VECTOR_MIN_ZOOM = 10;

const PISTE_DIFFICULTY_COLORS: Record<string, string> = {
  novice: "#4CAF50",
  easy: "#2196F3",
  intermediate: "#F44336",
  advanced: "#212121",
  expert: "#FF9800",
  freeride: "#FFEB3B",
  extreme: "#B71C1C",
};

const AERIALWAY_LABELS: Record<string, string> = {
  cable_car: "Cable Car",
  gondola: "Gondola",
  chair_lift: "Chairlift",
  mixed_lift: "Mixed Lift",
  drag_lift: "Drag Lift",
  "t-bar": "T-Bar",
  "j-bar": "J-Bar",
  platter: "Platter Lift",
  rope_tow: "Rope Tow",
  magic_carpet: "Magic Carpet",
};

const PISTE_TYPE_LABELS: Record<string, string> = {
  downhill: "Downhill",
  nordic: "Cross-Country",
  skitour: "Ski Touring",
  sled: "Sledding",
  hike: "Winter Hiking",
  sleigh: "Sleigh",
  ice_skate: "Ice Skating",
  snow_park: "Snow Park",
  playground: "Ski Playground",
  ski_jump: "Ski Jump",
  fatbike: "Fatbike",
  connection: "Connection",
};

function pistePopupHtml(props: Record<string, string | number | boolean>): string {
  const name = escapeHtml(String(props.name || "Unnamed piste"));
  const difficulty = escapeHtml(String(props.difficulty || ""));
  const type = String(props.pisteType || "");
  const ref = escapeHtml(String(props.ref || ""));
  const grooming = escapeHtml(String(props.grooming || ""));
  const lit = props.lit === true || props.lit === "true";
  const snowmaking = props.snowmaking === true || props.snowmaking === "true";

  const diffColor = PISTE_DIFFICULTY_COLORS[difficulty] || "#888";
  const diffLabel = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
  const typeLabel = PISTE_TYPE_LABELS[type] || type;

  let details = "";
  if (ref) details += `Ref: #${ref}`;
  if (grooming) details += `${details ? " · " : ""}Grooming: ${grooming}`;
  if (lit) details += `${details ? " · " : ""}Lit: Yes`;
  if (snowmaking) details += `${details ? " · " : ""}Snowmaking: Yes`;

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;padding-right:18px">
    <div style="font-size:14px;font-weight:600;margin-bottom:6px">${name}</div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      ${difficulty ? `<span style="background:${diffColor};color:${difficulty === "advanced" ? "#fff" : difficulty === "freeride" ? "#333" : "#fff"};font-size:11px;padding:2px 8px;border-radius:10px">${diffLabel}</span>` : ""}
      ${typeLabel ? `<span style="font-size:12px;color:#666">${typeLabel}</span>` : ""}
    </div>
    ${details ? `<div style="font-size:12px;color:#555;margin-top:4px">${details}</div>` : ""}
  </div>`;
}

function liftPopupHtml(props: Record<string, string | number | boolean>): string {
  const name = escapeHtml(String(props.name || "Unnamed lift"));
  const aerialway = String(props.aerialway || "");
  const typeLabel = escapeHtml(AERIALWAY_LABELS[aerialway] || aerialway);
  const occupancy = props.occupancy ? Number(props.occupancy) : null;
  const capacity = props.capacity ? Number(props.capacity) : null;
  const duration = props.duration ? Number(props.duration) : null;

  const details: string[] = [];
  if (capacity) details.push(`Capacity: ${capacity.toLocaleString()} p/h`);
  if (duration) details.push(`Duration: ${duration} min`);
  if (occupancy) details.push(`Occupancy: ${occupancy} per cabin`);

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:200px;padding-right:18px">
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">${name}</div>
    <div style="font-size:12px;color:#666;margin-bottom:4px">${typeLabel}</div>
    ${details.length ? `<div style="font-size:12px;color:#555">${details.join(" · ")}</div>` : ""}
  </div>`;
}

export function WinterSportsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-winter-sports");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const layerVisible = useWinterSportsStore((s) => s.layerVisible);
  const setLoading = useWinterSportsStore((s) => s.setLoading);
  const selectFeature = useWinterSportsStore((s) => s.selectFeature);
  useOverlayExclusion("winter-sports", layerVisible);
  useLayerReanchor(
    [
      RASTER_LAYER_ID,
      AREA_LAYER_ID,
      PISTE_LAYER_ID,
      PISTE_HIGHLIGHT_LAYER_ID,
      LIFT_LAYER_ID,
      LIFT_HIGHLIGHT_LAYER_ID,
    ],
    layerVisible,
  );
  const fetchedRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const fetchFeatures = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < VECTOR_MIN_ZOOM) return;

    const bounds = map.getBounds();
    const { apiUrl } = env;
    const url = `${apiUrl}/api/winter-sports/features?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const features: GeoJSON.Feature[] = [];

      for (const piste of data.pistes ?? []) {
        features.push({
          type: "Feature",
          geometry: piste.geometry,
          properties: {
            id: piste.id,
            featureKind: "piste",
            name: piste.name,
            pisteType: piste.type,
            difficulty: piste.difficulty,
            grooming: piste.grooming,
            lit: piste.lit,
            snowmaking: piste.snowmaking,
            ref: piste.ref,
          },
        });
      }

      for (const lift of data.lifts ?? []) {
        features.push({
          type: "Feature",
          geometry: lift.geometry,
          properties: {
            id: lift.id,
            featureKind: "lift",
            name: lift.name,
            aerialway: lift.aerialway,
            occupancy: lift.occupancy,
            capacity: lift.capacity,
            duration: lift.duration,
          },
        });
      }

      for (const area of data.areas ?? []) {
        features.push({
          type: "Feature",
          geometry: area.geometry,
          properties: {
            id: area.id,
            featureKind: "area",
            name: area.name,
          },
        });
      }

      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features,
      };

      const source = map.getSource(VECTOR_SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
      }
    } catch {
      // Silent failure
    } finally {
      setLoading(false);
    }
  }, [env, mapRef, setLoading]);

  // Manage layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          for (const id of [
            PISTE_HIGHLIGHT_LAYER_ID,
            LIFT_HIGHLIGHT_LAYER_ID,
            PISTE_LAYER_ID,
            LIFT_LAYER_ID,
            AREA_LAYER_ID,
            RASTER_LAYER_ID,
          ]) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(VECTOR_SOURCE_ID)) map.removeSource(VECTOR_SOURCE_ID);
          if (map.getSource(RASTER_SOURCE_ID)) map.removeSource(RASTER_SOURCE_ID);
        } catch {
          // In-flight tiles
        }
        popupRef.current?.remove();
        fetchedRef.current = false;
        return;
      }

      if (!map.isStyleLoaded()) return;

      // Raster source (OpenSnowMap)
      if (!map.getSource(RASTER_SOURCE_ID)) {
        map.addSource(RASTER_SOURCE_ID, {
          type: "raster",
          tiles: [`${env.apiUrl}/api/integrations/overlay-winter-sports/tiles/{z}/{x}/{y}.png`],
          tileSize: 256,
          maxzoom: 16,
          attribution: attributionHtml,
        });
      }

      if (!map.getLayer(RASTER_LAYER_ID)) {
        map.addLayer(
          {
            id: RASTER_LAYER_ID,
            type: "raster",
            source: RASTER_SOURCE_ID,
            paint: {
              "raster-opacity": 0.9,
              "raster-fade-duration": 200,
            },
          },
          getFirstSymbolLayerId(map),
        );
      }

      // Vector source for interactive features
      if (!map.getSource(VECTOR_SOURCE_ID)) {
        map.addSource(VECTOR_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      const beforeId = getFirstSymbolLayerId(map);

      // Ski area fill
      if (!map.getLayer(AREA_LAYER_ID)) {
        map.addLayer(
          {
            id: AREA_LAYER_ID,
            type: "fill",
            source: VECTOR_SOURCE_ID,
            minzoom: VECTOR_MIN_ZOOM,
            filter: ["==", ["get", "featureKind"], "area"],
            paint: {
              "fill-color": "rgba(200,220,255,0.15)",
              "fill-outline-color": "rgba(100,130,200,0.4)",
            },
          },
          beforeId,
        );
      }

      // Invisible piste lines (wide hit area)
      if (!map.getLayer(PISTE_LAYER_ID)) {
        map.addLayer(
          {
            id: PISTE_LAYER_ID,
            type: "line",
            source: VECTOR_SOURCE_ID,
            minzoom: VECTOR_MIN_ZOOM,
            filter: ["==", ["get", "featureKind"], "piste"],
            paint: {
              "line-color": "transparent",
              "line-width": 12,
              "line-opacity": 0,
            },
          },
          beforeId,
        );
      }

      // Piste highlight
      if (!map.getLayer(PISTE_HIGHLIGHT_LAYER_ID)) {
        map.addLayer(
          {
            id: PISTE_HIGHLIGHT_LAYER_ID,
            type: "line",
            source: VECTOR_SOURCE_ID,
            minzoom: VECTOR_MIN_ZOOM,
            filter: ["==", ["get", "id"], ""],
            paint: {
              "line-color": "#FFFFFF",
              "line-width": 4,
              "line-opacity": 0.6,
            },
            layout: {
              "line-cap": "round",
              "line-join": "round",
            },
          },
          beforeId,
        );
      }

      // Invisible lift lines (wide hit area)
      if (!map.getLayer(LIFT_LAYER_ID)) {
        map.addLayer(
          {
            id: LIFT_LAYER_ID,
            type: "line",
            source: VECTOR_SOURCE_ID,
            minzoom: VECTOR_MIN_ZOOM,
            filter: ["==", ["get", "featureKind"], "lift"],
            paint: {
              "line-color": "transparent",
              "line-width": 12,
              "line-opacity": 0,
            },
          },
          beforeId,
        );
      }

      // Lift highlight
      if (!map.getLayer(LIFT_HIGHLIGHT_LAYER_ID)) {
        map.addLayer(
          {
            id: LIFT_HIGHLIGHT_LAYER_ID,
            type: "line",
            source: VECTOR_SOURCE_ID,
            minzoom: VECTOR_MIN_ZOOM,
            filter: ["==", ["get", "id"], ""],
            paint: {
              "line-color": "#FFFFFF",
              "line-width": 4,
              "line-opacity": 0.6,
            },
            layout: {
              "line-cap": "round",
              "line-join": "round",
            },
          },
          beforeId,
        );
      }

      if (!fetchedRef.current) {
        fetchedRef.current = true;
        fetchFeatures();
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
  }, [mapReady, styleVersion, mapRef, layerVisible, fetchFeatures]);

  // Refetch on move
  const debouncedFetch = useDebouncedCallback(() => fetchFeatures(), 800);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, debouncedFetch]);

  // Click + hover handlers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, string | number | boolean>;
      const fid = String(props.id ?? "");
      selectFeature(fid);

      const kind = String(props.featureKind ?? "");
      const html = kind === "lift" ? liftPopupHtml(props) : pistePopupHtml(props);

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const activeLayers = INTERACTIVE_LAYERS.filter((id) => !!map.getLayer(id));
      if (activeLayers.length === 0) {
        map.getCanvasContainer().style.cursor = "";
        return;
      }
      const features = map.queryRenderedFeatures(e.point, { layers: [...activeLayers] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
        const fid = String(features[0].properties?.id ?? "");
        if (map.getLayer(PISTE_HIGHLIGHT_LAYER_ID)) {
          map.setFilter(PISTE_HIGHLIGHT_LAYER_ID, ["==", ["get", "id"], fid]);
        }
        if (map.getLayer(LIFT_HIGHLIGHT_LAYER_ID)) {
          map.setFilter(LIFT_HIGHLIGHT_LAYER_ID, ["==", ["get", "id"], fid]);
        }
      } else {
        map.getCanvasContainer().style.cursor = "";
        if (map.getLayer(PISTE_HIGHLIGHT_LAYER_ID)) {
          map.setFilter(PISTE_HIGHLIGHT_LAYER_ID, ["==", ["get", "id"], ""]);
        }
        if (map.getLayer(LIFT_HIGHLIGHT_LAYER_ID)) {
          map.setFilter(LIFT_HIGHLIGHT_LAYER_ID, ["==", ["get", "id"], ""]);
        }
      }
    };

    for (const layerId of INTERACTIVE_LAYERS) {
      map.on("click", layerId, onClick);
    }
    map.on("mousemove", onMouseMove);

    return () => {
      for (const layerId of INTERACTIVE_LAYERS) {
        map.off("click", layerId, onClick);
      }
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, selectFeature]);

  return null;
}
