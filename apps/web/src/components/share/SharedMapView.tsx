"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { MapCredits } from "@/components/map/MapCredits";
import { createGeoJsonSourceDataBridge } from "@/integration-api/map/layerStyleUtils";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapCreditsHtml, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import { loadMapLibreRuntime } from "@/lib/maplibreRuntime";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";

const POINTS_SOURCE = "shared-points-source";
const POINTS_LAYER = "shared-points-layer";
const ROUTE_SOURCE = "shared-route-source";
const ROUTE_CASING = "shared-route-casing";
const ROUTE_LINE = "shared-route-line";
// Matches SavedPlacesLayer's saved-pin red.
const POINT_COLOR = "#C62828";

export interface SharedMapPoint {
  lat: number;
  lng: number;
}

interface Props {
  points: SharedMapPoint[];
  routeGeometry?: [number, number][] | null;
}

function pointsData(points: SharedMapPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  };
}

function routeData(geometry: [number, number][] | null | undefined): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geometry?.length
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: geometry },
          },
        ]
      : [],
  };
}

function addLayers(map: maplibregl.Map): void {
  if (map.getSource(POINTS_SOURCE)) return;
  map.addSource(ROUTE_SOURCE, { type: "geojson", data: routeData(null) });
  map.addSource(POINTS_SOURCE, { type: "geojson", data: pointsData([]) });
  map.addLayer({
    id: ROUTE_CASING,
    type: "line",
    source: ROUTE_SOURCE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.planning.casing },
  });
  map.addLayer({
    id: ROUTE_LINE,
    type: "line",
    source: ROUTE_SOURCE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ROUTE_COLORS.active, "line-width": ROUTE_WIDTHS.planning.line },
  });
  map.addLayer({
    id: POINTS_LAYER,
    type: "circle",
    source: POINTS_SOURCE,
    paint: {
      "circle-radius": 7,
      "circle-color": POINT_COLOR,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
}

function fitToContent(
  map: maplibregl.Map,
  points: SharedMapPoint[],
  geometry: [number, number][] | null,
): void {
  const coords: [number, number][] = [
    ...points.map((p) => [p.lng, p.lat] as [number, number]),
    ...(geometry ?? []),
  ];
  if (coords.length === 0) return;
  let minLng = coords[0][0];
  let maxLng = coords[0][0];
  let minLat = coords[0][1];
  let maxLat = coords[0][1];
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 60, duration: 0, maxZoom: 15 },
  );
}

/** Read-only mini map for the public share page: markers plus an optional polyline. */
export function SharedMapView({ points, routeGeometry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createGeoJsonSourceDataBridge> | null>(null);
  if (!bridgeRef.current) bridgeRef.current = createGeoJsonSourceDataBridge();
  const bridge = bridgeRef.current;
  // Latest data, read by the map's `load` handler (which may run after the
  // props have already changed) — same pattern as AreaPickerMap's boundaryRef.
  const pointsRef = useRef<SharedMapPoint[]>(points);
  pointsRef.current = points;
  const routeRef = useRef<[number, number][] | null>(routeGeometry ?? null);
  routeRef.current = routeGeometry ?? null;
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const styleName = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant = resolvedMode === "dark" ? "dark" : "light";

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    let map: maplibregl.Map | null = null;
    let replay: (() => void) | null = null;

    const init = async () => {
      const maplibregl = await loadMapLibreRuntime();
      if (destroyed || !containerRef.current) return;
      const style =
        env.styleProvider === "openmapx"
          ? await loadOpenMapXStyle(env, variant)
          : await loadMaptilerStyle(styleName, env);
      if (destroyed || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: [0, 20],
        zoom: 2,
        // Credits render inline below via <MapCredits>, like the main map.
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });
      mapRef.current = map;

      map.on("load", () => {
        if (!map) return;
        addLayers(map);
        bridge.publish([
          { sourceId: ROUTE_SOURCE, data: routeData(routeRef.current) },
          { sourceId: POINTS_SOURCE, data: pointsData(pointsRef.current) },
        ]);
        bridge.apply(map);
        fitToContent(map, pointsRef.current, routeRef.current);
      });
      replay = () => bridge.apply(map as maplibregl.Map);
      map.on("styledata", replay);
      map.on("idle", replay);
    };

    // Style-fetch failures leave the container empty rather than emitting an
    // unhandled rejection — same degradation as AreaPickerMap.
    void init().catch(() => {});

    return () => {
      destroyed = true;
      if (map && replay && typeof map.off === "function") {
        map.off("styledata", replay);
        map.off("idle", replay);
      }
      map?.remove();
      mapRef.current = null;
    };
  }, [env, styleName, variant, bridge]);

  // Re-publish data and re-frame whenever it changes (e.g. route geometry arrives).
  useEffect(() => {
    const map = mapRef.current;
    bridge.publish([
      { sourceId: ROUTE_SOURCE, data: routeData(routeGeometry ?? null) },
      { sourceId: POINTS_SOURCE, data: pointsData(points) },
    ]);
    if (!map) return;
    bridge.apply(map);
    if (map.isStyleLoaded()) fitToContent(map, points, routeGeometry ?? null);
  }, [points, routeGeometry, bridge]);

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      <MapCredits html={baseMapCreditsHtml(env)} />
    </Box>
  );
}
