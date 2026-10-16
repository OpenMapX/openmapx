"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import type { Route } from "@openmapx/core";
import {
  type SavedPlaceFieldContributors,
  savedPlaceContributors,
} from "@openmapx/core/saved-place-contributors";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  snapshotContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { routeGeometryFeatures } from "@/components/map/layers/routeGeometryFeatures";
import { MapCredits } from "@/components/map/MapCredits";
import { createGeoJsonSourceDataBridge } from "@/integration-api/map/layerStyleUtils";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { renderedMapAttributionTracker } from "@/integration-api/overlay/renderedMapAttributionTracker";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapVectorCredits, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
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
  fieldContributors?: SavedPlaceFieldContributors;
}

type SharedMapRoute = Pick<
  Route,
  "geometry" | "geometryContributors" | "contributors" | "fieldContributors"
>;

interface Props {
  points: SharedMapPoint[];
  route?: SharedMapRoute | null;
}

function pointsData(points: SharedMapPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p) =>
      withFeatureContributors(
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        },
        savedPlaceContributors(p.fieldContributors, ["lat", "lng"]),
      ),
    ),
  };
}

function routeData(route: SharedMapRoute | null | undefined): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: route ? routeGeometryFeatures(route, {}) : [] };
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
export function SharedMapView({ points, route }: Props) {
  const [renderedAttributions, setRenderedAttributions] = useState<Attribution[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createGeoJsonSourceDataBridge> | null>(null);
  if (!bridgeRef.current) bridgeRef.current = createGeoJsonSourceDataBridge();
  const bridge = bridgeRef.current;
  // Keep framing inputs current while asynchronous map construction runs.
  const pointsRef = useRef<SharedMapPoint[]>(points);
  pointsRef.current = points;
  const routeRef = useRef<SharedMapRoute | null>(route ?? null);
  routeRef.current = route ?? null;
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const styleName = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant = resolvedMode === "dark" ? "dark" : "light";

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    let map: maplibregl.Map | null = null;
    let unsubscribeStyle: (() => void) | undefined;
    let unsubscribeRendered: (() => void) | undefined;

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

      const activeMap = map;
      fitToContent(activeMap, pointsRef.current, routeRef.current?.geometry ?? null);
      unsubscribeStyle = subscribeStyleLoaded(activeMap, () => {
        addLayers(activeMap);
        bridge.apply(activeMap);
      });
      unsubscribeRendered = renderedMapAttributionTracker(activeMap).subscribe(
        "shared-map-content",
        {
          kind: "geometry",
          layerIds: [POINTS_LAYER, ROUTE_CASING, ROUTE_LINE],
          publish: (entries) => {
            const captured = entries.flatMap((entry) => (entry.detail ? [entry.detail] : []));
            setRenderedAttributions((previous) =>
              JSON.stringify(previous) === JSON.stringify(captured) ? previous : captured,
            );
          },
        },
      );
    };

    // Style-fetch failures leave the container empty rather than emitting an
    // unhandled rejection — same degradation as AreaPickerMap.
    void init().catch(() => {});

    return () => {
      destroyed = true;
      unsubscribeRendered?.();
      unsubscribeStyle?.();
      map?.remove();
      mapRef.current = null;
    };
  }, [env, styleName, variant, bridge]);

  // Re-publish captured data whenever its geometry or receipts change.
  useEffect(() => {
    const map = mapRef.current;
    bridge.publish([
      { sourceId: ROUTE_SOURCE, data: routeData(route) },
      { sourceId: POINTS_SOURCE, data: pointsData(points) },
    ]);
    if (!map) return;
    bridge.apply(map);
  }, [points, route, bridge]);

  // Route receipt refreshes do not re-frame unchanged point/geometry inputs.
  const geometry = route?.geometry ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (map) fitToContent(map, points, geometry);
  }, [points, geometry]);

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      <MapCredits
        attributions={snapshotContributors(baseMapVectorCredits(env), renderedAttributions)}
      />
    </Box>
  );
}
