"use client";

import { routeColor, usePlaceStore, useRouteStops, useTransitRoute } from "@openmapx/core";
import {
  contributorsForField,
  contributorsForRecords,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";

const SOURCE_ID = "transit-route-detail-source";
const LINE_LAYER_ID = "transit-route-detail-line";
const STOPS_SOURCE_ID = "transit-route-detail-stops-source";
const STOPS_LAYER_ID = "transit-route-detail-stops";
const CURRENT_STOP_LAYER_ID = "transit-route-detail-current-stop";

type TransitRoute = ReturnType<typeof useTransitRoute>["data"];
type RouteStop = NonNullable<ReturnType<typeof useRouteStops>["data"]>[number];

// Use route geometry from the API (road-snapped) when available,
// otherwise fall back to connecting stop coordinates with straight lines.
function routeLineGeometry(
  route: TransitRoute,
  stops: readonly RouteStop[],
): GeoJSON.LineString | GeoJSON.MultiLineString {
  const geometry = route?.geometry;
  if (!geometry) {
    return { type: "LineString", coordinates: stops.map((s): [number, number] => [s.lng, s.lat]) };
  }
  return geometry.type === "MultiLineString"
    ? { type: "MultiLineString", coordinates: geometry.coordinates as [number, number][][] }
    : { type: "LineString", coordinates: geometry.coordinates as [number, number][] };
}

function transitRouteGroup(
  route: TransitRoute,
  stops: readonly RouteStop[],
  selectedPlaceId: string | undefined,
): MapLayerGroup {
  const lineColor = routeColor(route, PRIMARY_BLUE_HEX);
  return {
    sources: {
      [SOURCE_ID]: {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {
            _mapAttributions: serializeContributors(
              route?.geometry
                ? snapshotContributors(
                    contributorsForField(route, "geometry"),
                    contributorsForField(route, route.color ? "color" : "mode"),
                  )
                : snapshotContributors(
                    route ? contributorsForField(route, route.color ? "color" : "mode") : [],
                    contributorsForRecords(stops),
                  ),
            ),
          },
          geometry: routeLineGeometry(route, stops),
        },
      },
      [STOPS_SOURCE_ID]: {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: stops.map((s) => ({
            type: "Feature" as const,
            properties: {
              _mapAttributions: serializeContributors(s.contributors ?? []),
              id: s.id,
              name: s.name,
              isCurrent: s.id === selectedPlaceId,
            },
            geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
          })),
        },
      },
    },
    layers: [
      {
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        slot: "overlay-lines",
        order: 16,
        paint: {
          "line-color": lineColor,
          "line-width": 4,
          "line-opacity": 0.8,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      {
        id: STOPS_LAYER_ID,
        type: "circle",
        source: STOPS_SOURCE_ID,
        slot: "overlay-points",
        order: 18,
        filter: ["!=", ["get", "isCurrent"], true],
        paint: {
          "circle-radius": 5,
          "circle-color": "#fff",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": lineColor,
        },
      },
      {
        id: CURRENT_STOP_LAYER_ID,
        type: "circle",
        source: STOPS_SOURCE_ID,
        slot: "overlay-points",
        order: 19,
        filter: ["==", ["get", "isCurrent"], true],
        paint: {
          "circle-radius": 8,
          "circle-color": lineColor,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
        },
      },
    ],
  };
}

export function TransitRouteLayer() {
  const { mapReady, fitBounds } = useMap();
  const { selectedPlace, activeRouteId } = usePlaceStore();
  const { data: route } = useTransitRoute(activeRouteId);
  const { data: stops } = useRouteStops(activeRouteId);
  const selectedPlaceId = selectedPlace?.id;
  const shownStops = activeRouteId && stops?.length ? stops : null;

  useRenderedMapAttributions(
    "transit-route-detail",
    [LINE_LAYER_ID, STOPS_LAYER_ID, CURRENT_STOP_LAYER_ID],
    Boolean(activeRouteId),
  );
  useMapLayerGroup(
    useMemo(
      () => (shownStops ? transitRouteGroup(route, shownStops, selectedPlaceId) : null),
      [route, shownStops, selectedPlaceId],
    ),
  );

  useEffect(() => {
    void selectedPlaceId; // selecting another stop on the route re-fits it
    if (!mapReady || !shownStops) return;
    const geometry = routeLineGeometry(route, shownStops);
    const lineCoords =
      geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
    if (lineCoords.length < 2) return;
    const lngs = lineCoords.map((c) => c[0]);
    const lats = lineCoords.map((c) => c[1]);
    fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      60,
    );
  }, [mapReady, route, shownStops, selectedPlaceId, fitBounds]);

  return null;
}
