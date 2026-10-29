"use client";

import Box from "@mui/material/Box";
import { geoJsonBBox, type Route } from "@openmapx/core";
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
import { useStandaloneBasemapStyle, useStandaloneMap } from "@/components/map/useStandaloneMap";
import { createGeoJsonSourceDataBridge } from "@/integration-api/map/layerStyleUtils";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { renderedMapAttributionTracker } from "@/integration-api/overlay/renderedMapAttributionTracker";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapVectorCredits } from "@/lib/map";
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
  const bbox = geoJsonBBox({
    type: "MultiPoint",
    coordinates: [...points.map((p) => [p.lng, p.lat]), ...(geometry ?? [])],
  });
  if (!bbox) return;
  const [west, south, east, north] = bbox;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: 60, duration: 0, maxZoom: 15 },
  );
}

/** Read-only mini map for the public share page: markers plus an optional polyline. */
export function SharedMapView({ points, route }: Props) {
  const [renderedAttributions, setRenderedAttributions] = useState<Attribution[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [bridge] = useState(createGeoJsonSourceDataBridge);
  // Keep framing inputs current while asynchronous map construction runs.
  const pointsRef = useRef<SharedMapPoint[]>(points);
  pointsRef.current = points;
  const geometryRef = useRef(route?.geometry ?? null);
  geometryRef.current = route?.geometry ?? null;
  const env = useEnv();
  const loadStyle = useStandaloneBasemapStyle();

  const mapRef = useStandaloneMap(
    containerRef,
    () => ({
      loadStyle,
      options: { center: [0, 20], zoom: 2 },
      setup: (map) => {
        fitToContent(map, pointsRef.current, geometryRef.current);
        const unsubscribeStyle = subscribeStyleLoaded(map, () => {
          addLayers(map);
          bridge.apply(map);
        });
        const unsubscribeRendered = renderedMapAttributionTracker(map).subscribe(
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
        return () => {
          unsubscribeRendered();
          unsubscribeStyle();
        };
      },
    }),
    [bridge, loadStyle],
  );

  // Re-publish captured data whenever its geometry or receipts change.
  useEffect(() => {
    const map = mapRef.current;
    bridge.publish([
      { sourceId: ROUTE_SOURCE, data: routeData(route) },
      { sourceId: POINTS_SOURCE, data: pointsData(points) },
    ]);
    if (!map) return;
    bridge.apply(map);
  }, [bridge, mapRef, points, route]);

  // Route receipt refreshes do not re-frame unchanged point/geometry inputs.
  const geometry = route?.geometry ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (map) fitToContent(map, points, geometry);
  }, [geometry, mapRef, points]);

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      <MapCredits
        attributions={snapshotContributors(baseMapVectorCredits(env), renderedAttributions)}
      />
    </Box>
  );
}
