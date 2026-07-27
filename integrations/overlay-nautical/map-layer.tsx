"use client";

import {
  createPlace,
  PANEL,
  useOverlayExclusion,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { type HarborFeatureCollection, useNauticalStore } from "./store";

const SEAMARK_SOURCE = "openmapx-nautical-seamark-source";
const SEAMARK_LAYER = "openmapx-nautical-seamark-layer";

const DEPTH_RELIEF_SOURCE = "openmapx-nautical-depth-relief-source";
const DEPTH_RELIEF_LAYER = "openmapx-nautical-depth-relief-layer";
const DEPTH_CONTOUR_SOURCE = "openmapx-nautical-depth-contour-source";
const DEPTH_CONTOUR_LAYER = "openmapx-nautical-depth-contour-layer";

const NOAA_SOURCE = "openmapx-nautical-noaa-source";
const NOAA_LAYER = "openmapx-nautical-noaa-layer";

const KARTVERKET_SOURCE = "openmapx-nautical-kartverket-source";
const KARTVERKET_LAYER = "openmapx-nautical-kartverket-layer";

const HARBOR_SOURCE = "openmapx-nautical-harbor-source";
const HARBOR_ICON_LAYER = "openmapx-nautical-harbor-icons";
const HARBOR_LABEL_LAYER = "openmapx-nautical-harbor-labels";

const STATION_SOURCE = "openmapx-nautical-station-source";
const STATION_CIRCLE_LAYER = "openmapx-nautical-station-circles";
const STATION_LABEL_LAYER = "openmapx-nautical-station-labels";

const ALL_NAUTICAL_LAYER_IDS = [
  DEPTH_RELIEF_LAYER,
  DEPTH_CONTOUR_LAYER,
  NOAA_LAYER,
  KARTVERKET_LAYER,
  SEAMARK_LAYER,
  HARBOR_ICON_LAYER,
  HARBOR_LABEL_LAYER,
  STATION_CIRCLE_LAYER,
  STATION_LABEL_LAYER,
] as const;

/** Station marker palette — keyed by primary-type rank assigned by the backend. */
const STATION_COLOR_BY_RANK = [
  "match",
  ["get", "rank"],
  0,
  "#0284c7", // tide-predictions — strong blue
  1,
  "#0ea5e9", // water-level — sky blue
  2,
  "#14b8a6", // currents — teal
  3,
  "#10b981", // currents-predictions — green
  "#475569",
] as unknown as maplibregl.ExpressionSpecification;

const STATION_RADIUS_EXPR = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  3,
  10,
  5,
  14,
  7,
] as unknown as maplibregl.ExpressionSpecification;

function stationFilterToQuery(filter: "all" | "tide" | "water-level" | "currents"): string {
  switch (filter) {
    case "tide":
      return "types=tide-predictions";
    case "water-level":
      return "types=water-level";
    case "currents":
      return "types=currents,currents-predictions";
    default:
      return "";
  }
}

/** Rough US-waters bounding boxes for the NOAA chart coverage gate. */
const US_WATERS_BBOXES: ReadonlyArray<{
  south: number;
  north: number;
  west: number;
  east: number;
}> = [
  { south: 24, north: 50, west: -130, east: -65 },
  { south: 17, north: 22, west: -68, east: -64 },
  { south: 18, north: 29, west: -162, east: -154 },
  { south: 51, north: 72, west: -180, east: -130 },
  { south: 13, north: 20, west: 144, east: 147 },
];

function bboxIntersectsUsWaters(map: maplibregl.Map): boolean {
  const b = map.getBounds();
  const west = b.getWest();
  const east = b.getEast();
  const south = b.getSouth();
  const north = b.getNorth();
  return US_WATERS_BBOXES.some(
    (w) => west <= w.east && east >= w.west && south <= w.north && north >= w.south,
  );
}

/** Norway + Svalbard envelope — frontend gate for the Kartverket chart layer. */
const NORWAY_WATERS_BBOXES: ReadonlyArray<{
  south: number;
  north: number;
  west: number;
  east: number;
}> = [
  { south: 57, north: 72, west: 4, east: 32 }, // mainland + coast
  { south: 74, north: 81, west: 10, east: 35 }, // Svalbard
];

function bboxIntersectsNorwayWaters(map: maplibregl.Map): boolean {
  const b = map.getBounds();
  const west = b.getWest();
  const east = b.getEast();
  const south = b.getSouth();
  const north = b.getNorth();
  return NORWAY_WATERS_BBOXES.some(
    (w) => west <= w.east && east >= w.west && south <= w.north && north >= w.south,
  );
}

/**
 * Per-type harbor marker images. Each is a 36×36 SVG (rendered 2× for retina)
 * containing a colored circle and a white MUI-style icon centered inside.
 * The marker design mirrors the host-app `CategoryResultMarkers` pattern.
 */
const ANCHOR_PATH =
  "M17 15l1.55 1.55c-.96 1.69-3.33 3.04-5.55 3.37V11h3V9h-3V7.82C14.16 7.4 15 6.3 15 5c0-1.65-1.35-3-3-3S9 3.35 9 5c0 1.3.84 2.4 2 2.82V9H8v2h3v8.92c-2.22-.33-4.59-1.68-5.55-3.37L7 15l-4-3v3c0 3.88 4.92 7 9 7s9-3.12 9-7v-3l-4 3zM12 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z";
const SAILING_PATH =
  "M3 13.5h6V21H3v-7.5zm12-2.5h-3V5l3 1V3l-3-1V0h-2v2L7 4v3l3-1v5H7l-1.5 3h13L17 11zm-2 7h-2v-3h2v3zM17 15l-1.5 3h-9l-1.5-3h12z";
const FISH_PATH =
  "M16.78 11.5c.74-.83 1.31-1.86 1.58-3-1.16-.61-2.5-.94-3.93-.94-2.96 0-5.59 1.49-6.94 3.75H4l-2-2v8l2-2h3.49C8.85 17.51 11.48 19 14.43 19c1.43 0 2.78-.33 3.93-.94-.27-1.14-.84-2.17-1.58-3 .39-.43.7-.93.92-1.48-.21-.55-.52-1.05-.92-1.48z";

const HARBOR_TYPES = [
  "marina",
  "yacht_harbour",
  "port",
  "anchorage",
  "fishing",
  "harbour",
] as const;
type HarborType = (typeof HARBOR_TYPES)[number];

const HARBOR_TYPE_STYLE: Record<HarborType, { color: string; path: string }> = {
  marina: { color: "#1A73E8", path: SAILING_PATH },
  yacht_harbour: { color: "#1A73E8", path: SAILING_PATH },
  port: { color: "#475569", path: ANCHOR_PATH },
  anchorage: { color: "#0F9D58", path: ANCHOR_PATH },
  fishing: { color: "#F29900", path: FISH_PATH },
  harbour: { color: "#475569", path: ANCHOR_PATH },
};

function createHarborMarkerSvg(color: string, iconPath: string): string {
  // 36×36 marker: colored circle, white stroke, MUI 24px icon centered.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
  <circle cx="18" cy="18" r="14" fill="${color}" stroke="white" stroke-width="2"/>
  <path d="${iconPath}" fill="white" transform="translate(6, 6)"/>
</svg>`;
}

function harborImageId(type: HarborType): string {
  return `openmapx-nautical-harbor-${type}`;
}

function loadHarborImage(map: maplibregl.Map, type: HarborType): Promise<void> {
  const imageId = harborImageId(type);
  return new Promise((resolve) => {
    if (map.hasImage(imageId)) {
      resolve();
      return;
    }
    const style = HARBOR_TYPE_STYLE[type];
    const img = new Image(36, 36);
    img.onload = () => {
      if (!map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createHarborMarkerSvg(style.color, style.path))}`;
  });
}

const HARBOR_ICON_IMAGE_EXPR = [
  "match",
  ["get", "type"],
  "marina",
  harborImageId("marina"),
  "yacht_harbour",
  harborImageId("yacht_harbour"),
  "port",
  harborImageId("port"),
  "anchorage",
  harborImageId("anchorage"),
  "fishing",
  harborImageId("fishing"),
  harborImageId("harbour"),
] as unknown as maplibregl.ExpressionSpecification;

const HARBOR_ICON_SIZE_EXPR = [
  "interpolate",
  ["linear"],
  ["zoom"],
  6,
  0.4,
  10,
  0.55,
  14,
  0.75,
] as unknown as maplibregl.ExpressionSpecification;

function makeSeamarkTileUrl(apiUrl: string): string {
  if (apiUrl) {
    const base = apiUrl.replace(/\/$/, "");
    return `${base}/api/integrations/overlay-nautical/seamark/{z}/{x}/{y}.png`;
  }
  return "/api/integrations/overlay-nautical/seamark/{z}/{x}/{y}.png";
}

function makeDepthContourTileUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}/api/integrations/overlay-nautical/depth/contour/{z}/{x}/{y}.png`;
}

function makeDepthReliefTileUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}/api/integrations/overlay-nautical/depth/relief/{z}/{x}/{y}.png`;
}

function makeNoaaTileUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}/api/integrations/overlay-nautical/noaa/{z}/{x}/{y}.png`;
}

function makeKartverketTileUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, "");
  return `${base}/api/integrations/overlay-nautical/charts/no/{z}/{x}/{y}.png`;
}

export function NauticalLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();

  const layerVisible = useNauticalStore((s) => s.panelOpen && s.layerVisible);
  useIntegrationAttribution("overlay-nautical", layerVisible);
  const showSeamarks = useNauticalStore((s) => s.showSeamarks);
  const showDepth = useNauticalStore((s) => s.showDepth);
  const showNoaaCharts = useNauticalStore((s) => s.showNoaaCharts);
  const showHarbors = useNauticalStore((s) => s.showHarbors);
  const showTideStations = useNauticalStore((s) => s.showTideStations);
  const tideStationFilter = useNauticalStore((s) => s.tideStationFilter);
  const setHarbors = useNauticalStore((s) => s.setHarbors);
  const setHarborsError = useNauticalStore((s) => s.setHarborsError);
  const setLoading = useNauticalStore((s) => s.setLoading);

  useOverlayExclusion("nautical", layerVisible);
  useLayerReanchor(ALL_NAUTICAL_LAYER_IDS, layerVisible);

  const harborsFetchKeyRef = useRef<string | null>(null);
  const stationsFetchKeyRef = useRef<string | null>(null);

  const fetchStations = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const params = new URLSearchParams({
      west: String(b.getWest()),
      south: String(b.getSouth()),
      east: String(b.getEast()),
      north: String(b.getNorth()),
    });
    const typeQuery = stationFilterToQuery(tideStationFilter);
    if (typeQuery) {
      const [k, v] = typeQuery.split("=");
      if (k && v !== undefined) params.set(k, v);
    }
    const url = `${env.apiUrl.replace(/\/$/, "")}/api/integrations/overlay-nautical/stations?${params.toString()}`;
    if (stationsFetchKeyRef.current === url) return;
    stationsFetchKeyRef.current = url;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as GeoJSON.FeatureCollection;
      const source = map.getSource(STATION_SOURCE) as GeoJSONSource | undefined;
      if (source) source.setData(data);
    } catch {
      // Silent: stations are decorative, never fatal.
    }
  }, [env.apiUrl, mapRef, tideStationFilter]);

  const fetchHarbors = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const zoom = Math.round(map.getZoom());
    if (zoom < 6) {
      setHarbors({ type: "FeatureCollection", features: [] });
      return;
    }
    const url = `${env.apiUrl.replace(/\/$/, "")}/api/integrations/overlay-nautical/harbors?south=${b.getSouth()}&north=${b.getNorth()}&west=${b.getWest()}&east=${b.getEast()}&zoom=${zoom}`;
    if (harborsFetchKeyRef.current === url) return;
    harborsFetchKeyRef.current = url;
    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setHarborsError(true);
        return;
      }
      const data = (await res.json()) as HarborFeatureCollection;
      setHarbors(data);
      setHarborsError(false);
      const source = map.getSource(HARBOR_SOURCE) as GeoJSONSource | undefined;
      if (source) source.setData(data);
    } catch {
      setHarborsError(true);
    } finally {
      setLoading(false);
    }
  }, [env.apiUrl, mapRef, setHarbors, setHarborsError, setLoading]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const sync = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }
      const before = getFirstSymbolLayerId(map);

      // ---- Depth shaded relief (lowest layer) ----
      if (layerVisible && showDepth) {
        if (!map.getSource(DEPTH_RELIEF_SOURCE)) {
          map.addSource(DEPTH_RELIEF_SOURCE, {
            type: "raster",
            tiles: [makeDepthReliefTileUrl(env.apiUrl)],
            tileSize: 256,
            minzoom: 0,
            maxzoom: 8,
          });
        }
        if (!map.getLayer(DEPTH_RELIEF_LAYER)) {
          map.addLayer(
            {
              id: DEPTH_RELIEF_LAYER,
              type: "raster",
              source: DEPTH_RELIEF_SOURCE,
              maxzoom: 8,
              paint: { "raster-opacity": 0.55, "raster-fade-duration": 200 },
            },
            before,
          );
        }
      } else {
        if (map.getLayer(DEPTH_RELIEF_LAYER)) map.removeLayer(DEPTH_RELIEF_LAYER);
        if (map.getSource(DEPTH_RELIEF_SOURCE)) map.removeSource(DEPTH_RELIEF_SOURCE);
      }

      // ---- Depth contour lines (zoom 7+) ----
      if (layerVisible && showDepth) {
        if (!map.getSource(DEPTH_CONTOUR_SOURCE)) {
          map.addSource(DEPTH_CONTOUR_SOURCE, {
            type: "raster",
            tiles: [makeDepthContourTileUrl(env.apiUrl)],
            tileSize: 256,
            minzoom: 6,
          });
        }
        if (!map.getLayer(DEPTH_CONTOUR_LAYER)) {
          map.addLayer(
            {
              id: DEPTH_CONTOUR_LAYER,
              type: "raster",
              source: DEPTH_CONTOUR_SOURCE,
              minzoom: 6,
              paint: { "raster-opacity": 0.9, "raster-fade-duration": 200 },
            },
            before,
          );
        }
      } else {
        if (map.getLayer(DEPTH_CONTOUR_LAYER)) map.removeLayer(DEPTH_CONTOUR_LAYER);
        if (map.getSource(DEPTH_CONTOUR_SOURCE)) map.removeSource(DEPTH_CONTOUR_SOURCE);
      }

      // ---- Charts: multi-provider raster (US: NOAA, Norway+Svalbard: Kartverket)
      // Each provider's source is added/removed based on viewport bbox so they
      // stack naturally when both regions are visible (e.g. cross-Atlantic).
      const wantNoaa = layerVisible && showNoaaCharts && bboxIntersectsUsWaters(map);
      if (wantNoaa) {
        if (!map.getSource(NOAA_SOURCE)) {
          map.addSource(NOAA_SOURCE, {
            type: "raster",
            tiles: [makeNoaaTileUrl(env.apiUrl)],
            tileSize: 256,
            minzoom: 3,
            maxzoom: 18,
          });
        }
        if (!map.getLayer(NOAA_LAYER)) {
          map.addLayer(
            {
              id: NOAA_LAYER,
              type: "raster",
              source: NOAA_SOURCE,
              paint: { "raster-opacity": 0.9, "raster-fade-duration": 200 },
            },
            before,
          );
        }
      } else {
        if (map.getLayer(NOAA_LAYER)) map.removeLayer(NOAA_LAYER);
        if (map.getSource(NOAA_SOURCE)) map.removeSource(NOAA_SOURCE);
      }

      const wantKartverket = layerVisible && showNoaaCharts && bboxIntersectsNorwayWaters(map);
      if (wantKartverket) {
        if (!map.getSource(KARTVERKET_SOURCE)) {
          map.addSource(KARTVERKET_SOURCE, {
            type: "raster",
            tiles: [makeKartverketTileUrl(env.apiUrl)],
            tileSize: 256,
            minzoom: 3,
            maxzoom: 18,
          });
        }
        if (!map.getLayer(KARTVERKET_LAYER)) {
          map.addLayer(
            {
              id: KARTVERKET_LAYER,
              type: "raster",
              source: KARTVERKET_SOURCE,
              paint: { "raster-opacity": 0.9, "raster-fade-duration": 200 },
            },
            before,
          );
        }
      } else {
        if (map.getLayer(KARTVERKET_LAYER)) map.removeLayer(KARTVERKET_LAYER);
        if (map.getSource(KARTVERKET_SOURCE)) map.removeSource(KARTVERKET_SOURCE);
      }

      // ---- Seamarks (always on top of bathymetry/chart raster) ----
      if (layerVisible && showSeamarks) {
        if (!map.getSource(SEAMARK_SOURCE)) {
          map.addSource(SEAMARK_SOURCE, {
            type: "raster",
            tiles: [makeSeamarkTileUrl(env.apiUrl)],
            tileSize: 256,
            maxzoom: 18,
          });
        }
        if (!map.getLayer(SEAMARK_LAYER)) {
          map.addLayer(
            {
              id: SEAMARK_LAYER,
              type: "raster",
              source: SEAMARK_SOURCE,
              paint: { "raster-opacity": 0.95, "raster-fade-duration": 200 },
            },
            before,
          );
        }
      } else {
        if (map.getLayer(SEAMARK_LAYER)) map.removeLayer(SEAMARK_LAYER);
        if (map.getSource(SEAMARK_SOURCE)) map.removeSource(SEAMARK_SOURCE);
      }

      // ---- Harbor markers (top layer) ----
      if (layerVisible && showHarbors) {
        if (!map.getSource(HARBOR_SOURCE)) {
          map.addSource(HARBOR_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        // Symbol layer needs the per-type marker images. Loading is async; the
        // layer can be added before images resolve (MapLibre tolerates a missing
        // image by skipping the feature) so we kick off loads in parallel and
        // don't await them inside the sync handler.
        for (const t of HARBOR_TYPES) {
          void loadHarborImage(map, t);
        }
        if (!map.getLayer(HARBOR_ICON_LAYER)) {
          map.addLayer({
            id: HARBOR_ICON_LAYER,
            type: "symbol",
            source: HARBOR_SOURCE,
            minzoom: 6,
            layout: {
              "icon-image": HARBOR_ICON_IMAGE_EXPR,
              "icon-size": HARBOR_ICON_SIZE_EXPR,
              "icon-allow-overlap": true,
              "icon-ignore-placement": false,
            },
          });
        }
        if (!map.getLayer(HARBOR_LABEL_LAYER)) {
          map.addLayer({
            id: HARBOR_LABEL_LAYER,
            type: "symbol",
            source: HARBOR_SOURCE,
            minzoom: 11,
            layout: {
              "text-field": ["get", "name"],
              "text-font": ["Noto Sans Bold"],
              "text-size": 11,
              "text-anchor": "top",
              "text-offset": [0, 1.2],
              "text-allow-overlap": false,
              "text-optional": true,
            },
            paint: {
              "text-color": "#0f172a",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            },
          });
        }
      } else {
        if (map.getLayer(HARBOR_LABEL_LAYER)) map.removeLayer(HARBOR_LABEL_LAYER);
        if (map.getLayer(HARBOR_ICON_LAYER)) map.removeLayer(HARBOR_ICON_LAYER);
        if (map.getSource(HARBOR_SOURCE)) map.removeSource(HARBOR_SOURCE);
        harborsFetchKeyRef.current = null;
      }

      // ---- Tide / water-level / currents station markers ----
      if (layerVisible && showTideStations) {
        if (!map.getSource(STATION_SOURCE)) {
          map.addSource(STATION_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        if (!map.getLayer(STATION_CIRCLE_LAYER)) {
          map.addLayer({
            id: STATION_CIRCLE_LAYER,
            type: "circle",
            source: STATION_SOURCE,
            minzoom: 6,
            paint: {
              "circle-radius": STATION_RADIUS_EXPR,
              "circle-color": STATION_COLOR_BY_RANK,
              "circle-opacity": 0.9,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.5,
            },
          });
        }
        if (!map.getLayer(STATION_LABEL_LAYER)) {
          map.addLayer({
            id: STATION_LABEL_LAYER,
            type: "symbol",
            source: STATION_SOURCE,
            minzoom: 10,
            layout: {
              "text-field": ["get", "name"],
              "text-font": ["Noto Sans Bold"],
              "text-size": 11,
              "text-anchor": "top",
              "text-offset": [0, 0.8],
              "text-allow-overlap": false,
              "text-optional": true,
            },
            paint: {
              "text-color": "#0f172a",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            },
          });
        }
      } else {
        if (map.getLayer(STATION_LABEL_LAYER)) map.removeLayer(STATION_LABEL_LAYER);
        if (map.getLayer(STATION_CIRCLE_LAYER)) map.removeLayer(STATION_CIRCLE_LAYER);
        if (map.getSource(STATION_SOURCE)) map.removeSource(STATION_SOURCE);
        stationsFetchKeyRef.current = null;
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [
    mapReady,
    styleVersion,
    mapRef,
    layerVisible,
    showSeamarks,
    showDepth,
    showNoaaCharts,
    showHarbors,
    showTideStations,
    env.apiUrl,
  ]);

  // Refetch harbors on viewport change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !showHarbors) return;
    void fetchHarbors();
    const onMoveEnd = () => {
      void fetchHarbors();
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapReady, mapRef, layerVisible, showHarbors, fetchHarbors]);

  // Refetch stations on viewport change + on initial layer open
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !showTideStations) return;
    void fetchStations();
    const onMoveEnd = () => {
      void fetchStations();
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapReady, mapRef, layerVisible, showTideStations, fetchStations]);

  // Refetch when the type filter changes (force-bust the cache key)
  useEffect(() => {
    if (!layerVisible || !showTideStations) return;
    stationsFetchKeyRef.current = null;
    void fetchStations();
  }, [tideStationFilter, layerVisible, showTideStations, fetchStations]);

  // Re-evaluate chart-provider coverage when the viewport changes. Each
  // provider's source is added when its bbox intersects and removed when
  // it doesn't.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!layerVisible || !showNoaaCharts) return;

    const reevaluate = () => {
      // NOAA (US)
      const inUs = bboxIntersectsUsWaters(map);
      const hasNoaa = !!map.getLayer(NOAA_LAYER);
      if (inUs && !hasNoaa) {
        map.fire("styledata");
      } else if (!inUs && hasNoaa) {
        map.removeLayer(NOAA_LAYER);
        if (map.getSource(NOAA_SOURCE)) map.removeSource(NOAA_SOURCE);
      }
      // Kartverket (Norway + Svalbard)
      const inNo = bboxIntersectsNorwayWaters(map);
      const hasKartverket = !!map.getLayer(KARTVERKET_LAYER);
      if (inNo && !hasKartverket) {
        map.fire("styledata");
      } else if (!inNo && hasKartverket) {
        map.removeLayer(KARTVERKET_LAYER);
        if (map.getSource(KARTVERKET_SOURCE)) map.removeSource(KARTVERKET_SOURCE);
      }
    };
    map.on("moveend", reevaluate);
    return () => {
      map.off("moveend", reevaluate);
    };
  }, [mapRef, mapReady, layerVisible, showNoaaCharts]);

  // Click handling — open place panel for clicked harbor
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !showHarbors) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, string | number | undefined>;
      const id = String(props.id ?? "").trim();
      if (!id) return;
      // These layers render Point features; narrowing beats a cast, which
      // silently produced undefined coordinates for any other geometry.
      if (f.geometry.type !== "Point") return;
      const [lng, lat] = f.geometry.coordinates;
      const name = String(props.name ?? `Harbour ${id}`);
      const rawType = (props.type as string | undefined) ?? "harbour";
      const place = createPlace({
        primaryScheme: "openseamap-harbour",
        ids: { "openseamap-harbour": id },
        name,
        address: "",
        coordinates: [lng, lat],
        category: rawType.replace(/_/g, " "),
        rawCategory: `nautical/${rawType}`,
      });
      usePlaceStore.getState().setSelectedPlace(place);
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    };

    const onMouseMove = (ev: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(HARBOR_ICON_LAYER)) return;
      const features = map.queryRenderedFeatures(ev.point, { layers: [HARBOR_ICON_LAYER] });
      map.getCanvasContainer().style.cursor = features.length > 0 ? "pointer" : "";
    };

    map.on("click", HARBOR_ICON_LAYER, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(HARBOR_ICON_LAYER);
    return () => {
      map.off("click", HARBOR_ICON_LAYER, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      INTERACTIVE_LAYER_IDS.delete(HARBOR_ICON_LAYER);
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, showHarbors]);

  // Click handling — open place panel for clicked NOAA tide station.
  // Each station carries a `network` property; we route to the matching
  // place-resolver scheme (registered by the per-network knowledge integration).
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !showTideStations) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | undefined>;
      const id = String(p.id ?? "").trim();
      if (!id) return;
      // These layers render Point features; narrowing beats a cast, which
      // silently produced undefined coordinates for any other geometry.
      if (f.geometry.type !== "Point") return;
      const [lng, lat] = f.geometry.coordinates;
      const name = String(p.name ?? id);
      const network = String(p.network ?? "noaa");
      const country = p.country ? String(p.country) : undefined;

      // Network → place scheme. Each knowledge-tides-* integration owns its
      // own resolver. Falls back to `coops:` for legacy NOAA entries.
      const scheme = (() => {
        switch (network) {
          case "noaa":
            return "coops";
          case "ca-iwls":
            return "ca-iwls";
          case "kartverket":
            return "kartverket";
          case "pegel":
            return "pegel";
          case "emodnet":
            return "emodnet-sl";
          case "ioc":
            return "ioc";
          default:
            return "coops";
        }
      })();

      const place = createPlace({
        primaryScheme: scheme,
        ids: { [scheme]: id },
        name,
        address: String(p.state ?? ""),
        countryCode: country?.toLowerCase(),
        coordinates: [lng, lat],
        category: "Tide Station",
        rawCategory: "marine/tide_station",
      });
      usePlaceStore.getState().setSelectedPlace(place);
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    };

    const onMouseMove = (ev: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(STATION_CIRCLE_LAYER)) return;
      const features = map.queryRenderedFeatures(ev.point, {
        layers: [STATION_CIRCLE_LAYER],
      });
      if (features.length > 0) map.getCanvasContainer().style.cursor = "pointer";
    };

    map.on("click", STATION_CIRCLE_LAYER, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(STATION_CIRCLE_LAYER);
    return () => {
      map.off("click", STATION_CIRCLE_LAYER, onClick);
      map.off("mousemove", onMouseMove);
      INTERACTIVE_LAYER_IDS.delete(STATION_CIRCLE_LAYER);
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, showTideStations]);

  return null;
}

export default NauticalLayer;
